import {TikTokError} from './client.js';
import {ACCOUNT_FIELDS,POST_FIELDS,HISTORY_FIELDS,windows,observations,unavailable,historicalObservations} from './contract.js';
const availability=error=>error.code==='PERMISSION_DENIED'?'inaccessible':error.code==='REQUEST_UNSUPPORTED_OR_INVALID'?'unsupported_or_invalid_request':'failed';
const fatal=error=>['TOKEN_EXPIRED_OR_INVALID','COLLECTION_BUDGET_EXHAUSTED','RATE_LIMIT_DEFERRED'].includes(error.code);
export async function probe(client){
  const identity=await client.request('business/get/',{fields:['username','display_name']});
  if(identity.data.username!=='thegreatfroglondon')throw new TikTokError('ACCOUNT_IDENTITY_MISMATCH');
  const page=await client.request('business/video/list/',{fields:['item_id','create_time'],max_count:1,cursor:0});
  validatePage(page.data);
  return {account_verified:true,api_version:'v1.3',identity:identity.data,catalogue_probe_count:page.data.videos.length,collection_started:false};
}
export function validatePage(data){if(!Array.isArray(data.videos)||typeof data.has_more!=='boolean'||data.videos.some(p=>typeof p.item_id!=='string'||!p.item_id))throw new TikTokError('INVALID_PAGE');if(data.has_more&&(data.cursor==null||!['string','number'].includes(typeof data.cursor)))throw new TikTokError('INVALID_CURSOR');}
export async function collect({client,store,accountId,importId,start,end,maxPages=10000}){
  const results=[],failures=[];
  const persist=(grain,state,rows=[])=>store.save(accountId,importId,grain,state,rows);
  const args=(data,fields,kind,endpoint,extra={})=>({data,fields,kind,endpoint,accountId,runId:importId,observedAt:new Date().toISOString(),...extra});
  // Each profile field commits independently. A denied audience metric cannot erase identity.
  for(const field of ACCOUNT_FIELDS){const grain=`account:${field}`;if((await store.checkpoint(accountId,importId,grain))?.complete)continue;
    let rows,state;
    try{const r=await client.request('business/get/',{fields:[field]});rows=observations(args(r.data,[field],field.startsWith('audience_')?'audience_snapshot':'current_snapshot','business/get/',{requestId:r.request_id}));state={complete:true,availability:rows[0].availability};}
    catch(error){if(fatal(error))throw error;const status=availability(error);rows=unavailable(args({},[field],'current_snapshot','business/get/'),status);state={complete:status!=='failed',availability:status,error_code:error.code};failures.push({grain,...state});}
    await persist(grain,state,rows);results.push({grain,...state});
  }
  // First preserve the complete accessible catalogue without insight scopes or date filters.
  const grain='catalogue',saved=await store.checkpoint(accountId,importId,grain);let state=saved||{cursor:0,complete:false,pages:0,post_count:0,earliest_native:null,latest_native:null,seen_cursors:[]};
  try{
    while(!state.complete){
      if(state.pages>=maxPages)throw new TikTokError('PAGE_BUDGET_EXHAUSTED');
      const r=await client.request('business/video/list/',{fields:['item_id','create_time','caption'],cursor:state.cursor,max_count:20});validatePage(r.data);
      if(r.data.has_more&&(String(r.data.cursor)===String(state.cursor)||state.seen_cursors.includes(String(r.data.cursor))))throw new TikTokError('PAGINATION_CYCLE');
      const times=r.data.videos.map(p=>p.create_time).filter(v=>v!=null).map(String).sort();
      const next={...state,cursor:r.data.cursor??state.cursor,complete:!r.data.has_more,pages:state.pages+1,post_count:state.post_count+r.data.videos.length,earliest_native:[state.earliest_native,...times].filter(Boolean).sort()[0]||null,latest_native:[state.latest_native,...times].filter(Boolean).sort().at(-1)||null,seen_cursors:[...state.seen_cursors,String(r.data.cursor)]};
      const rows=r.data.videos.flatMap(p=>observations(args(p,['item_id','create_time','caption'],'metadata','business/video/list/',{resourceId:p.item_id,requestId:r.request_id})));
      await persist(grain,next,rows);state=next;
    }
    results.push({grain,...state});
  }catch(error){await persist(grain,{...state,error_code:error.code||'WAREHOUSE_FAILED'});failures.push({grain,availability:'failed',complete:false,error_code:error.code||'WAREHOUSE_FAILED'});if(fatal(error))throw error;}
  // A separate paginated stream for every field avoids all-or-nothing field selection.
  for(const field of POST_FIELDS.filter(f=>!['item_id','create_time','caption'].includes(f))){
    const g=`posts:${field}`;let cp=await store.checkpoint(accountId,importId,g)||{cursor:0,pages:0,complete:false,post_count:0,seen_cursors:[]};
    try{while(!cp.complete){
      if(cp.pages>=maxPages)throw new TikTokError('PAGE_BUDGET_EXHAUSTED');
      const r=await client.request('business/video/list/',{fields:['item_id','create_time',field],cursor:cp.cursor,max_count:20});validatePage(r.data);
      if(r.data.has_more&&(String(r.data.cursor)===String(cp.cursor)||cp.seen_cursors.includes(String(r.data.cursor))))throw new TikTokError('PAGINATION_CYCLE');
      const next={cursor:r.data.cursor??cp.cursor,pages:cp.pages+1,complete:!r.data.has_more,post_count:cp.post_count+r.data.videos.length,seen_cursors:[...cp.seen_cursors,String(r.data.cursor)],availability:'available'};
      const rows=r.data.videos.flatMap(p=>observations(args(p,[field],field.startsWith('audience_')?'post_audience_snapshot':field==='impression_sources'?'post_traffic_source_snapshot':'lifetime_post_counter','business/video/list/',{resourceId:p.item_id,requestId:r.request_id})));
      await persist(g,next,rows);cp=next;
    }results.push({grain:g,...cp});}
    catch(error){if(fatal(error))throw error;const status=availability(error);await persist(g,{...cp,complete:status!=='failed',availability:status,error_code:error.code},unavailable(args({},[field],'capability','business/video/list/'),status));failures.push({grain:g,availability:status,error_code:error.code});}
  }
  // Probe all requested historical windows newest-first; empty/rejected windows
  // do not establish a retention bound. Preserve native dates/periods verbatim.
  for(const window of windows(start,end))for(const field of HISTORY_FIELDS){
    const g=`history:${field}:${window.start}:${window.end}`;if((await store.checkpoint(accountId,importId,g))?.complete)continue;
    let rows,cp;const extra={start:window.start,end:window.end};
    try{const r=await client.request('business/get/',{fields:[field],start_date:window.start,end_date:window.end});rows=historicalObservations(args(r.data,[field],'native_period_unverified','business/get/',{...extra,requestId:r.request_id}));cp={complete:true,availability:rows.some(row=>row.availability==='available')?'available':'missing',returned_dates:[...new Set(rows.map(row=>row.applied_start).filter(Boolean))].sort(),returned_row_count:rows.length,requested_start:window.start,requested_end:window.end,applied_start:null,applied_end:null,native_period_semantics_verified:false};}
    catch(error){if(fatal(error))throw error;const status=availability(error);rows=unavailable(args({},[field],'native_period_unverified','business/get/',extra),status);cp={complete:status!=='failed',availability:status,error_code:error.code,...extra};failures.push({grain:g,...cp});}
    await persist(g,cp,rows);results.push({grain:g,...cp});
  }
  return {import_id:importId,account_id:accountId,results,failures,catalogue:state,requested_start:start,requested_end:end,historical_bounds_verified:false,notes:['Native historical periods require API date evidence; no daily values reconstructed.','Post counter snapshots are lifetime, not publication-period activity.','Returned missing fields and rejected requests are not zero.']};
}

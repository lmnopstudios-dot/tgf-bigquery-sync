import {addDays,date,localDay,localMidnightSeconds} from '../meta/config.js';
const json=value=>JSON.stringify(value??null);
export const instagramIdentityFields=a=>a.auth_path==='instagram_login'?'id,user_id,username,account_type,followers_count,media_count':'id,ig_id,username,followers_count,media_count';
export const mediaType=media=>media._story?'STORY':media.media_product_type==='REELS'?'REELS':media.media_type;
const metricKey=p=>[p.metric,p.period,p.metric_type,p.breakdown||'',p.timeframe||''].join('|');
export function metricParams(profile,{start,end,media=false,timezone='UTC'}){
  return {metric:profile.metric,period:profile.period,...(!media?{metric_type:profile.metric_type,...(profile.timeframe?{timeframe:profile.timeframe}:{since:localMidnightSeconds(start,timezone),until:localMidnightSeconds(addDays(end,1),timezone)})}:{}),...(profile.breakdown?{breakdown:profile.breakdown}: {})};
}
export async function probeMetric(client,resource,profile,window,media=false){
  try{const rows=await client.pages(`${resource}/insights`,metricParams(profile,{...window,media}));
    if(rows.some(r=>r.name!==profile.metric||r.period!==profile.period))throw Object.assign(new Error('Metric period/name differs from requested contract'),{code:'METRIC_CONTRACT_MISMATCH'});
    return {profile,key:metricKey(profile),availability:rows.length?'available':'unavailable',rows};
  }catch(error){if(error.code!=='UNSUPPORTED_REQUEST')throw error;return {profile,key:metricKey(profile),availability:'unsupported_or_unavailable',rows:[],reason:error.code};}
}
export function metricObservations(probe,{account,resource,media=null,window,observedAt,apiVersion}){
  const p=probe.profile,base={account_id:account.account_id,resource_id:String(resource),media_type:media?mediaType(media):'ACCOUNT',metric:p.metric,period:p.period,metric_type:p.metric_type,timeframe:p.timeframe||null,evidence_kind:p.evidence_kind,paid_organic_scope:'native_scope_unverified',availability:probe.availability,definition:null,value:null,breakdown_json:json(null),native_json:json(probe.rows),publication_at:media?.timestamp||null,permalink:media?.permalink||null,observed_at:observedAt,report_date:null,requested_start:window.start,requested_end:window.end,reporting_timezone:account.timezone,api_version:apiVersion,profile_key:probe.key};
  if(probe.availability!=='available')return [{...base,definition:probe.reason||'No native evidence returned'}];
  return probe.rows.flatMap(row=>{
    const definition=[row.title,row.description].filter(Boolean).join(': ')||row.name;
    if(row.total_value){const v=row.total_value.value;return [{...base,definition,value:typeof v==='number'?String(v):null,breakdown_json:json(row.total_value.breakdowns||null),evidence_kind:media?(p.period==='lifetime'?'lifetime_total':'snapshot'):p.evidence_kind==='audience_snapshot'?'audience_snapshot':'window_total'}];}
    if(!Array.isArray(row.values)||!row.values.length)return [{...base,definition,availability:'unavailable'}];
    return row.values.map(v=>{
      // Time-series end_time is the exclusive end of the native bucket. Lifetime
      // media observations never become historical daily evidence.
      const daily=!media&&p.evidence_kind==='historical_daily'&&p.period==='day'&&v.end_time;
      const report_date=daily?addDays(localDay(new Date(v.end_time),account.timezone),-1):null;
      if(report_date&&(report_date<window.start||report_date>window.end))throw Object.assign(new Error('Instagram bucket outside requested window'),{code:'INVALID_METRIC_WINDOW'});
      return {...base,definition,report_date,value:typeof v.value==='number'?String(v.value):null,breakdown_json:typeof v.value==='object'?json(v.value):json(null),evidence_kind:media?(p.period==='lifetime'?'lifetime_total':'snapshot'):daily?'historical_daily':p.evidence_kind};
    });
  });
}
export async function collectInstagramSnapshot({config,account,client,start,end,now=()=>new Date()}){
  const observedAt=now().toISOString(),window={start:date(start),end:date(end),timezone:account.timezone};
  const native=await client.request(account.account_id,{fields:instagramIdentityFields(account)});
  if(String(native.id)!==account.account_id||!native.username&&account.auth_path==='facebook_login'||account.auth_path==='instagram_login'&&!['BUSINESS','MEDIA_CREATOR','CREATOR'].includes(native.account_type))throw Object.assign(new Error('Connected Instagram professional account identity is unverified'),{code:'INSTAGRAM_IDENTITY_UNVERIFIED'});
  const media=await client.pages(`${account.account_id}/media`,{fields:'id,media_type,media_product_type,timestamp,permalink,caption,children{id,media_type}'});
  const stories=await client.pages(`${account.account_id}/stories`,{fields:'id,media_type,media_product_type,timestamp,permalink'});
  const rows=[],capabilities=[];
  const capture=async(resource,profiles,item=null)=>{
    for(const profile of profiles){const probe=await probeMetric(client,resource,profile,window,Boolean(item));capabilities.push({resource_id:String(resource),media_type:item?mediaType(item):'ACCOUNT',profile_key:probe.key,availability:probe.availability});rows.push(...metricObservations(probe,{account,resource,media:item,window,observedAt,apiVersion:config.api_version}));}
  };
  await capture(account.account_id,account.account_profiles);
  // All retrieved media are retained, including old publications; insights are
  // current lifetime observations, never reconstructed daily performance.
  const allMedia=[...media,...stories.map(m=>({...m,_story:true}))];
  for(const item of allMedia)await capture(item.id,account.media_profiles[mediaType(item)]||[],item);
  if(native.followers_count!=null)rows.push({account_id:account.account_id,resource_id:account.account_id,media_type:'ACCOUNT',metric:'followers_count',period:'lifetime',metric_type:'snapshot',timeframe:null,evidence_kind:'snapshot',paid_organic_scope:'account_total',availability:'available',definition:'Native current follower count observed at collection time; not reconstructed historical followers',value:String(native.followers_count),breakdown_json:'null',native_json:json({followers_count:native.followers_count}),publication_at:null,permalink:null,observed_at:observedAt,report_date:null,requested_start:start,requested_end:end,reporting_timezone:account.timezone,api_version:config.api_version,profile_key:'followers_count|snapshot'});
  return {observations:rows,media:allMedia.map(m=>({account_id:account.account_id,media_id:String(m.id),media_type:mediaType(m),publication_at:m.timestamp||null,permalink:m.permalink||null,metadata_json:json(m),observed_at:observedAt,api_version:config.api_version})),capabilities,limitations:['Native Instagram insights scope may include paid distribution; it is not asserted exclusively organic.','Lifetime media totals are current observations, not activity within the publication-date selection.','Expired Stories and unavailable historical audience/follower evidence cannot be reconstructed.']};
}

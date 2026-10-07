import {createHash} from 'node:crypto';
import {date,addDays} from '../meta/config.js';
export const ACCOUNT_FIELDS=['username','display_name','profile_image','bio_description','profile_deep_link','is_verified','is_business_account','followers_count','following_count','likes','total_likes','video_count','videos_count','audience_countries','audience_genders','audience_age','audience_ages','audience_cities','audience_activity'];
export const POST_FIELDS=['item_id','create_time','caption','share_url','embed_url','thumbnail_url','media_type','is_ad','video_duration','video_views','likes','comments','shares','favorites','reach','total_time_watched','average_time_watched','full_video_watched_rate','impression_sources','audience_countries','audience_genders','audience_cities','audience_types','video_view_retention','new_followers','profile_views','website_clicks','phone_number_clicks','lead_submissions','app_download_clicks','email_clicks','address_clicks','engagement_likes'];
// Candidates are probed independently, never assumed from a dashboard. The native
// window is retained; ambiguous follower fields are never labelled daily totals.
export const HISTORY_FIELDS=['followers_count','profile_views','video_views','likes','comments','shares','unique_video_views','engaged_audience','audience_activity','daily_new_followers','daily_lost_followers','daily_total_followers'];
const units={video_duration:'seconds',total_time_watched:'seconds',average_time_watched:'seconds',full_video_watched_rate:'native_rate'};
const metadata=new Set(['item_id','create_time','caption','share_url','embed_url','thumbnail_url','media_type','is_ad','username','display_name','profile_image','bio_description','profile_deep_link','is_verified','is_business_account']);
export function windows(start,end,days=7){date(start);date(end);if(start>end||!Number.isInteger(days)||days<1||days>7)throw new Error('Invalid preservation dates');const result=[];for(let s=start;s<=end;s=addDays(s,days))result.push({start:s,end:[addDays(s,days-1),end].sort()[0]});return result.reverse();}
export function observations({data,fields,accountId,resourceId=accountId,kind,runId,observedAt,endpoint,start=null,end=null,requestId=null}){
  return fields.map(metric=>{
    const present=Object.hasOwn(data,metric)&&data[metric]!=null,value=present?data[metric]:null;
    const numeric=typeof value==='number'&&Number.isFinite(value)?value:null;
    const evidence_kind=metadata.has(metric)?'metadata':kind;
    const row={account_id:accountId,resource_id:String(resourceId),metric,unit:metadata.has(metric)?'text':units[metric]||(typeof value==='object'?'native_breakdown':'count'),evidence_kind,availability:present?'available':'missing',value:numeric,native_json:JSON.stringify(value),publication_native:data.create_time==null?null:String(data.create_time),permalink:data.share_url||null,requested_start:start,requested_end:end,applied_start:null,applied_end:null,reporting_timezone:null,timezone_evidence:'API timezone not established; native timestamps retained',api_version:'v1.3',endpoint,request_id:requestId,retrieved_at:observedAt,run_id:runId};
    row.evidence_id=createHash('sha256').update(JSON.stringify([runId,accountId,resourceId,metric,evidence_kind,start,end])).digest('hex');return row;
  });
}
export function unavailable(args,status){return observations({...args,data:{}}).map(r=>({...r,availability:status}));}

export function historicalObservations(args){
  const rows=observations({...args,kind:'native_period_unverified'});
  // Preserve the complete native aggregate/daily container even when an API
  // returns dates outside the requested window or silently applies defaults.
  for(const row of rows)row.native_json=JSON.stringify({aggregate:args.data[row.metric]??null,metrics:args.data.metrics??null,start_date:args.data.start_date??null,end_date:args.data.end_date??null,timezone:args.data.timezone??null});
  if(Array.isArray(args.data.metrics))for(const bucket of args.data.metrics){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(bucket.date||''))continue;
    const dated=observations({...args,data:bucket,kind:'native_dated_observation',start:bucket.date,end:bucket.date});
    for(const row of dated){row.applied_start=bucket.date;row.applied_end=bucket.date;row.requested_start=args.start;row.requested_end=args.end;row.unit=row.metric.startsWith('audience_')?'native_breakdown':row.unit;}
    rows.push(...dated);
  }
  return rows;
}

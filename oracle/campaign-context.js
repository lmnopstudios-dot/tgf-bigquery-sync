import { naturalReportPeriod } from './report-natural-period.js';

const bounded = value => typeof value==='string' ? value.slice(0,240) : null;
export function validateCampaignRequest(value){
  if(value==null)return null;
  if(!value||typeof value!=='object'||!['latest','named'].includes(value.selector))throw new Error('Invalid campaign request');
  const candidate=c=>{
    if(!c||typeof c.entity_id!=='string'||!c.entity_id)throw new Error('Invalid campaign identity');
    return Object.fromEntries(['entity_id','entity_name','account','channel','send_time','send_time_semantics','reporting_timezone','reporting_cutoff','retrieved_at'].map(k=>[k,bounded(c[k])]));
  };
  return {selector:value.selector,name:bounded(value.name),channel:bounded(value.channel),selected:value.selected?candidate(value.selected):null,candidates:(value.candidates||[]).slice(0,50).map(candidate),date_mode:value.date_mode==='since_send'?'since_send':null,metadata_attempted:Boolean(value.metadata_attempted),clarification_attempted:Boolean(value.clarification_attempted),send_date:bounded(value.send_date),cutoff:bounded(value.cutoff),requested_metrics:(value.requested_metrics||['purchases','revenue']).filter(x=>['purchases','revenue'].includes(x))};
}
export const sinceSend=text=>/\b(?:since|from)\b[\s\S]{0,45}\b(?:sent|send|sending)\b/i.test(text);
export function campaignContextPatch(base,text,now){
  const latest=/\b(?:last|latest|most recent)\s+(?:klaviyo\s+)?(?:email(?:\s+campaign)?|campaign)\b/i.test(text);
  const named=text.match(/\bcampaign\s+(?:called|named)\s+["“]?([^"”?.]+)|\b["“]([^"”]+)["”]\s+(?:email\s+)?campaign\b/i)||text.match(/\b(?:from|for)\s+([^?.]+?)\s+(?:email\s+)?campaign\b/i)||text.match(/\bcampaign\s+["“]([^"”]+)["”]/i);
  const fresh=latest||named;
  const pending=base.campaign_request;
  if(!fresh&&!pending)return null;
  // A new analytical subject must bypass pending clarification handling.
  if(!fresh&&/\b(?:products?|conversion rates?|mobile|desktop|stock|inventory|flows?|customers?|export|download)\b/i.test(text))return null;
  const dates=naturalReportPeriod(text,now);
  const select=text.match(/^(?:(?:use|choose|pick|select)\s+)?(?:option\s+|choice\s+)?#?(\d+)\s*[.!]?$/i);
  const matches=pending?.candidates.filter(c=>[c.entity_id,c.entity_name].some(v=>v?.toLowerCase()===text.toLowerCase().replace(/[.!]$/,'')));
  const exact=matches?.length===1?matches[0]:null;
  const selected=exact||(select?pending?.candidates[Number(select[1])-1]:null);
  const continuation= !fresh && (sinceSend(text)||dates||selected||matches?.length||pending?.metadata_attempted&&(!pending.selected||!pending.selected.send_time));
  if(!fresh&&!continuation)return null;
  const request=fresh?{selector:latest?'latest':'named',name:(named?.[1]?.trim()||named?.[2]?.trim()||'').replace(/\s+(?:since|from|during|for|in)\s+(?=20\d{2}|(?:it|sending|send)\b|(?:jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+20\d{2})[\s\S]*$/i,'')||null,channel:/\bemail\b/i.test(text)?'email':null,requested_metrics:['purchases','revenue'],cutoff:new Date(now).toISOString()}:structuredClone(pending);
  if(selected){request.selected=selected;request.candidates=[];}
  if(dates&&!sinceSend(text))request.date_mode=null;
  if(sinceSend(text))request.date_mode='since_send';
  if(!fresh&&dates&&/\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,2}\s+(?:jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+20\d{2}\b/i.test(text)&&pending.metadata_attempted&&!pending.selected?.send_time){request.send_date=dates.start_date;request.date_mode='since_send';}
  if(!fresh&&!selected&&!dates&&!sinceSend(text)&&!matches?.length&&pending.metadata_attempted){request.selector='named';request.name=text.replace(/[.!]$/,'');request.selected=null;request.candidates=[];request.metadata_attempted=false;}
  const out={...(fresh?{}:base),requested_subject:'klaviyo_email',metrics:['email_attribution'],analysis_type:'ecommerce',platform:'klaviyo',grain:'month',email_report_kind:'campaign',tool_route:'get_klaviyo_email_performance',campaign_request:request,unresolved_required_fields:[],...(dates||{})};
  return {patch:out,continuation:Boolean(continuation)};
}

/** Placed Order provenance establishes purchase events, never distinct orders. */
export const isCampaignPurchaseMetric=row=>/^(?:shopify|woocommerce):Placed Order(?:;|$)/i.test(row.metric_provenance||'');

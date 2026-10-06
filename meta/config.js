import {createHash} from 'node:crypto';
export const date = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value||'') || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value) throw new Error('Expected a real YYYY-MM-DD date');
  return value;
};
export const addDays=(value,n)=>new Date(Date.parse(`${date(value)}T00:00:00Z`)+n*86400000).toISOString().slice(0,10);
export const localDay=(now,timezone)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
export const positive=(n,max,name)=>{if(!Number.isInteger(n)||n<1||n>max)throw new Error(`Invalid ${name}`);return n;};
const id=value=>{if(!/^\d+$/.test(String(value||'')))throw new Error('Configure an explicit numeric Meta/Instagram ID');return String(value);};
const json=(env,key)=>{try{return JSON.parse(env[key]||'[]');}catch{throw new Error(`Invalid ${key}`);}};
const profiles=items=>{
  if(!Array.isArray(items))throw new Error('Metric profiles must be arrays');
  return items.map(p=>{
    if(!/^[a-z][a-z0-9_]+$/.test(p.metric||'')||!['day','lifetime','week','days_28','month','total_over_range'].includes(p.period)||!['default','time_series','total_value'].includes(p.metric_type)||!['historical_daily','window_total','lifetime_total','snapshot','audience_snapshot'].includes(p.evidence_kind))throw new Error('Invalid reviewed Instagram metric profile');
    if(p.evidence_kind==='historical_daily'&&(p.period!=='day'||p.metric_type!=='time_series'))throw new Error('Historical daily profiles require day/time_series');
    if(p.breakdown&&!/^[a-z_]+(?:,[a-z_]+)*$/.test(p.breakdown))throw new Error('Invalid aggregate breakdown');
    if(p.timeframe&&!['last_14_days','last_30_days','last_90_days','prev_month','this_month','this_week'].includes(p.timeframe))throw new Error('Invalid reviewed Instagram timeframe');
    return {timeframe:p.timeframe||null,metric:p.metric,period:p.period,metric_type:p.metric_type,evidence_kind:p.evidence_kind,breakdown:p.breakdown||null};
  });
};
export function loadMetaConfig(env=process.env){
  if(!/^v\d+\.0$/.test(env.META_API_VERSION||''))throw new Error('META_API_VERSION is required; review the currently supported version before configuring');
  const ads=json(env,'META_AD_ACCOUNTS_JSON'),instagram=json(env,'INSTAGRAM_ACCOUNTS_JSON');
  if(!Array.isArray(ads)||!Array.isArray(instagram)||!ads.length&&!instagram.length)throw new Error('Configure explicit Meta ad and/or Instagram professional accounts; IDs are never inferred from Google Ads');
  const normalize=(a,ig=false)=>{
    const account_id=id(a.account_id);
    if(!['active','historical_only','disabled'].includes(a.collection_status))throw new Error('Explicit collection_status required');
    try{new Intl.DateTimeFormat('en',{timeZone:a.timezone}).format();}catch{throw new Error('Invalid reporting timezone');}
    if(!a.timezone)throw new Error('Reporting timezone required');
    if(!a.token_env||!/^[A-Z][A-Z0-9_]+$/.test(a.token_env))throw new Error('Reviewed token_env required');
    const base={account_id,display_name:a.display_name||account_id,collection_status:a.collection_status,timezone:a.timezone,token_env:a.token_env};
    if(ig){
      if(!['facebook_login','instagram_login'].includes(a.auth_path))throw new Error('Explicit supported Instagram auth_path required');
      const media_profiles=Object.fromEntries(Object.entries(a.media_profiles||{}).map(([k,v])=>{if(!['IMAGE','CAROUSEL_ALBUM','VIDEO','REELS','STORY'].includes(k))throw new Error('Invalid media profile type');const reviewed=profiles(v);if(reviewed.some(p=>!['lifetime_total','snapshot'].includes(p.evidence_kind)||p.evidence_kind==='lifetime_total'&&p.period!=='lifetime'))throw new Error('Media profiles must distinguish lifetime totals from current snapshots; historical daily media reconstruction is prohibited');return[k,reviewed];}));
      return {...base,auth_path:a.auth_path,account_profiles:profiles(a.account_profiles||[]),media_profiles,history_days:positive(a.history_days||1,90,'Instagram probe window')};
    }
    if(!/^[A-Z]{3}$/.test(a.currency||''))throw new Error('Reviewed account currency required');
    if(!['impression','conversion','mixed'].includes(a.action_report_time))throw new Error('Explicit action_report_time required');
    if(!/^[a-z_][a-z0-9_.]{0,79}$/.test(a.purchase_action_type||'')||!/(?:^|[._])purchase$/.test(a.purchase_action_type))throw new Error('Select exactly one native purchase action type');
    if(a.attribution_windows&&(!Array.isArray(a.attribution_windows)||!a.attribution_windows.length||a.attribution_windows.some(w=>!['1d_click','7d_click','1d_view','1d_engaged_view','28d_click'].includes(w))))throw new Error('Invalid requested attribution windows');
    return {...base,currency:a.currency,history_start:date(a.history_start||'2024-01-01'),history_end:a.history_end?date(a.history_end):null,action_report_time:a.action_report_time,purchase_action_type:a.purchase_action_type,attribution_windows:a.attribution_windows||null,refresh_days:positive(a.refresh_days||35,90,'attribution refresh window')};
  };
  const accounts=ads.map(a=>normalize(a)),ig=instagram.map(a=>normalize(a,true));
  for(const list of [accounts,ig])if(new Set(list.map(a=>a.account_id)).size!==list.length)throw new Error('Duplicate account IDs');
  return {api_version:env.META_API_VERSION,accounts,instagram:ig,max_calls:positive(Number(env.META_MAX_CALLS||500),10000,'API budget'),max_pages:positive(Number(env.META_MAX_PAGES||100),1000,'pagination budget')};
}
export const contractId=(config,account)=>createHash('sha256').update(JSON.stringify({api_version:config.api_version,account})).digest('hex').slice(0,24);

export function localMidnightSeconds(value,timezone='UTC'){
  const target=Date.parse(`${date(value)}T00:00:00Z`);let candidate=target;
  for(let i=0;i<3;i++){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric',hourCycle:'h23'}).formatToParts(new Date(candidate)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
    const rendered=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second);candidate+=target-rendered;
  }
  return Math.floor(candidate/1000);
}

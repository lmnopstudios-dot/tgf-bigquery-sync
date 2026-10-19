// Event fixture with independently hand-counted expectations in the incident suite.
// No real identities or production counts are used.
export const RETENTION_REQUEST=`Which TGF collaborations bring customers back after their first purchase?
Analyse customers whose first-ever purchase was during the last three years through the latest completed day, including online and in-store purchases where governed evidence supports them.
Group by collaboration first, then show the strongest individual pieces within each collaboration.
Show first-purchase customer counts, mature 90-day and 180-day denominators, repeat customers and rates, median days to second purchase, and whether the second purchase was the same collaboration, another collaboration or the core range.
Rank primarily by 90-day repeat-purchase rate. Disclose small samples, history and customer-linkage limitations. Preserve supported results if charts or exports are unavailable.`;
const event=(customer,order,timestamp,pieces,extra={})=>({source_platform:'woo',source_store:'ww',customer,order,timestamp,pieces,...extra});
const piece=(id,names=[],group=null)=>({id,title:'Piece '+id,names,group});
export const retentionEvents=[
 event('prior','prior0','2022-01-01T12:00:00Z',[piece('old')]),
 event('prior','prior1','2025-01-01T12:00:00Z',[piece('a',['alpha'])]),
 event('one','1','2025-01-01T12:00:00Z',[piece('a',['alpha']),piece('b',['beta']),piece('a2',['alpha'])]),
 event('one','2','2025-01-11T12:00:00Z',[piece('a',['alpha'])]),
 event('two','3','2025-01-01T12:00:00Z',[piece('a',['alpha'])]),
 event('two','4','2025-05-01T12:00:00Z',[piece('core',[],'core')]),
 event('three','5','2025-01-01T12:00:00Z',[piece('b',['beta'])]),
 event('three','6','2025-01-31T12:00:00Z',[piece('a',['alpha']),piece('b',['beta'])]),
 event('never','7','2025-01-01T12:00:00Z',[piece('a',['alpha'])]),
 event('young','8','2026-10-01T12:00:00Z',[piece('a',['alpha'])]),
 event('generic','9','2025-01-01T12:00:00Z',[piece('g',['collaborations'],'collaboration')]),
 event('unknown','10','2025-01-01T12:00:00Z',[piece('u')]),
 event('conflict','11','2025-01-01T12:00:00Z',[piece('x',['alpha','beta'])]),
 event(null,'12','2025-01-01T12:00:00Z',[piece('a',['alpha'])]),
 event('migrated','13','2025-01-01T12:00:00Z',[piece('a',['alpha'])],{migrated:true}),
 event('cancelled','14','2025-01-01T12:00:00Z',[piece('a',['alpha'])],{cancelled:true}),
 event('refunded','15','2025-01-01T12:00:00Z',[piece('a',['alpha'])],{refunded:true}),
 event('today','16','2026-10-18T23:30:00Z',[piece('a',['alpha'])]),
 event('shop','17','2025-01-01T12:00:00Z',[piece('a',['alpha'])],{source_platform:'shopify',source_store:'shopify'}),
 event('shop','18','2025-03-02T12:00:00Z',[piece('b',['beta'])],{source_platform:'shopify',source_store:'shopify'})
];
// Aggregate-only fixture adapter. Membership is calculated from events, not supplied rates.
export function fixtureRetention(events,args,{pieces=false}={}){
 const date=t=>new Intl.DateTimeFormat('en-CA',{timeZone:args.time_zone||'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
 const names=p=>p.names.filter(n=>!['collaboration','collaborations'].includes(n));
 const buckets=new Map(),sources=new Map();
 for(const e of events){if(e.source_platform!==args.entry_source||date(e.timestamp)>args.observation_end)continue;const k=e.source_platform+'/'+e.source_store;const a=sources.get(k)||[];a.push(e);sources.set(k,a);}
 const coverage=[];
 for(const all of sources.values()){
  const valid=all.filter(e=>e.customer&&!e.migrated&&!e.cancelled&&!e.refunded),customers=new Map();
  for(const e of valid){const a=customers.get(e.customer)||[];a.push(e);customers.set(e.customer,a);}
  let eligible=0,named=0,generic=0,unknown=0;
  for(const history of customers.values()){
   history.sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.order.localeCompare(b.order));const first=history[0];
   if(date(first.timestamp)<args.cohort_entry_start||date(first.timestamp)>args.cohort_entry_end)continue;eligible++;
   const classified=first.pieces.filter(p=>names(p).length===1),isGeneric=first.pieces.some(p=>p.group==='collaboration'||p.names.includes('collaborations'));
   if(classified.length)named++;else if(isGeneric)generic++;else unknown++;
   const second=history.find(e=>e.timestamp>first.timestamp);
   const memberships=new Map();for(const p of classified){const name=names(p)[0];memberships.set(name+(pieces?'/'+p.id:''),{name,p});}
   for(const {name,p} of memberships.values())for(const window of [90,180]){
    const key=[first.source_platform,first.source_store,name,pieces?p.id:'',window].join('/');
    let b=buckets.get(key);if(!b){b={source_platform:first.source_platform,source_store:first.source_store,collaboration_name:name,...(pieces?{entry_product_ref:first.source_platform+':'+first.source_store+':'+p.id,entry_product_title:p.title}:{}),window_days:window,cohort_customers:0,mature_customers:0,repeat_customers:0,same_collaboration:0,different_collaboration:0,core_range:0,unknown:0,days:[]};buckets.set(key,b);}
    b.cohort_customers++;const age=(Date.parse(args.observation_end)-Date.parse(date(first.timestamp)))/86400000;if(age<window)continue;b.mature_customers++;
    if(!second||(Date.parse(date(second.timestamp))-Date.parse(date(first.timestamp)))/86400000>window)continue;
    b.repeat_customers++;b.days.push((Date.parse(second.timestamp)-Date.parse(first.timestamp))/86400000);
    const kinds=new Set(second.pieces.map(p=>names(p).length===1?(names(p)[0]===name?'same_collaboration':'different_collaboration'):['core','core_range'].includes(p.group)?'core_range':'unknown'));
    b[kinds.size===1?[...kinds][0]:'unknown']++;
   }
  }
  const first=all[0],ds=all.map(e=>date(e.timestamp)).sort();coverage.push({source_platform:first.source_platform,source_store:first.source_store,eligible_first_customers:eligible,named_customers:named,generic_only_customers:generic,unknown_customers:unknown,history_start:ds[0],history_end:ds.at(-1),identified_orders:all.filter(e=>e.customer).length,anonymous_orders:all.filter(e=>!e.customer).length,migrated_orders:all.filter(e=>e.migrated||e.cancelled).length,excluded_orders:all.filter(e=>e.refunded).length});
 }
 return [...buckets.values()].map(({days,...b})=>{days.sort((a,b)=>a-b);return {...b,coverage,median_days_to_second:days.length?(days[Math.floor((days.length-1)/2)]+days[Math.floor(days.length/2)])/2:null};});
}

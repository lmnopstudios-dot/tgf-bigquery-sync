// Aggregate-only retained evidence diagnostic. No vendor calls or warehouse writes.
import {createBigQueryClient} from '../bigquery/client.js';
import {loadLoyaltyConfig} from '../loyaltylion/runtime-config.js';
import {loyaltyQueries} from '../oracle/loyaltylion.js';
import {datasetLocation} from '../bigquery/dataset-location.js';
const [start_date,end_date]=process.argv.slice(2);
if(!/^\d{4}-\d{2}-\d{2}$/.test(start_date||'')||!/^\d{4}-\d{2}-\d{2}$/.test(end_date||'')||start_date>end_date||
 Date.parse(end_date)-Date.parse(start_date)>31*86400000)throw Error('Invalid bounded period');
try{
 const c=loadLoyaltyConfig(),{bigquery,project}=createBigQueryClient();
 const location=await datasetLocation(bigquery,project,c.dataset);
 if(await datasetLocation(bigquery,project,'shopify_data')!==location)throw Error('Region mismatch');
 const params={program_id:c.program_id,start_date,end_date,as_of:new Date().toISOString(),
  roster_run:null,transaction_runs:[],tier:null,channel:null,currencies:[],matrixify_app_id:'gid://shopify/App/1758145'};
 const types={program_id:'STRING',start_date:'STRING',end_date:'STRING',as_of:'STRING',
  roster_run:'STRING',transaction_runs:['STRING'],tier:'STRING',channel:'STRING',currencies:['STRING'],matrixify_app_id:'STRING'};
 const query=async(sql,operation)=>(await bigquery.query({query:sql,params,types,location,useLegacySql:false,
  maximumBytesBilled:'1000000000',jobTimeoutMs:15000,labels:{component:'oracle_loyalty',operation}}))[0];
 const q=loyaltyQueries(project,c.dataset);
 const coverage=await query(q.coverage,'linkage_diagnostic_coverage');
 params.roster_run=coverage.find(r=>r.resource==='customers'&&r.status==='complete')?.run_id??null;
 params.transaction_runs=[...new Set(coverage.filter(r=>r.resource==='transactions'&&r.status==='complete').map(r=>r.run_id))];
 if(!params.roster_run||!params.transaction_runs.length)throw Error('Missing complete retained coverage');
 const filters=await query('SELECT @channel IS NULL AS channel_unfiltered,@tier IS NULL AS tier_unfiltered,ARRAY_LENGTH(@currencies) currency_filter_length','linkage_diagnostic_filters');
 const counts=await query(q.linkage_coverage,'linkage_diagnostic_counts');
 const rows=await query(q.linkage,'linkage_diagnostic_rows');
 console.log(JSON.stringify({read_only:true,start_date,end_date,filter_binding:filters[0],
   counters:counts[0],aggregate_rows:rows.length,
   represented_point_records:rows.reduce((n,r)=>n+Number(r.point_records||0),0),
   matched_qualifying_orders:rows.reduce((n,r)=>n+Number(r.linked_qualifying_orders||0),0)}));
}catch(e){
 console.error(JSON.stringify({read_only:true,status:'unavailable',
  reason:['invalidQuery','notFound','accessDenied','quotaExceeded'].includes(e.errors?.[0]?.reason)?e.errors[0].reason:'bounded_read_failed'}));
 process.exitCode=1;
}

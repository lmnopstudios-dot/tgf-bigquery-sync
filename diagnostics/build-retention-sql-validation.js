// Build reviewable SQL artifacts locally; no credentials, network or warehouse reads.
import {createCustomerJourneyService,customerJourneySql} from '../oracle/customer-journey.js';
import {retentionBigQueryFixture} from '../test/helpers/retention-bigquery-sql-fixture.js';
import {writeFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
export async function retentionValidationCases(){
 const cases=[],project='gf-full-data',identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
 for(const [source,store] of [['woo','ww'],['woo','usd'],['shopify','shopify']])for(const group of ['retention_windows','retention_piece_windows','retention_baseline_windows']){
  let captured;
  const bigquery={query:async q=>{
   if(q.query.includes('retention_members')){captured=q;return [[]];}
   if(q.query.startsWith('SELECT state,start_date,end_date,mapping_count'))return [[{state:'ready',start_date:'1900-01-01',end_date:'2026-10-19',mapping_count:3}]];
   return [[...['ww','usd','shopify'].map(source_store=>({source_store,identified_profiles:1,mapped_profiles:1,unmatched_profiles:0,qualifying_orders:1,matched_orders:1,unmatched_orders:0,ambiguous_orders:0,unavailable_orders:0,email_linked_guest_or_unknown_records:0,conflicting_orders:0,shared_address_orders:0}))]];
  }};
  const service=createCustomerJourneyService({bigquery,project,env:{ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:identity.dataset,ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:identity.snapshot}});
  await service.analyzeCustomerJourney({cohort_entry_start:'2022-10-19',cohort_entry_end:'2026-10-19',observation_end:'2026-10-19',time_zone:'Europe/London',first_order_semantic:'first_observed_ever',cohort:{entry_source:source,entry_product_classification:group==='retention_baseline_windows'?null:'collaboration'},group_by:[group],limit:99},{sourceStore:store});
  if(!captured?.query.includes('ci_mapping'))throw Error('Missing captured linked execution');
  const settings={params:captured.params,types:captured.types,useLegacySql:false,location:'US',maximumBytesBilled:'20000000000',jobTimeoutMs:10000};
  const synthetic=retentionBigQueryFixture(group,source,store);
  cases.push({source,store,group,full_select:{...settings,query:customerJourneySql(project,group,source,store,identity)},transaction_script:{...settings,maximumBytesBilled:captured.maximumBytesBilled,query:captured.query},synthetic});
 }
 return cases;
}
if(process.argv[1]===new URL(import.meta.url).pathname){const cases=await retentionValidationCases();writeFileSync(new URL('./retention-sql-validation.json.gz',import.meta.url),gzipSync(JSON.stringify({project:'gf-full-data',snapshot:'history-20261022-billing-v3',cases}),{mtime:0}));console.log('Built nine full linked SELECT/script and synthetic execution cases');}

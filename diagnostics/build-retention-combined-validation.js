import {writeFileSync,readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {retentionValidationCases} from './build-retention-sql-validation.js';
import {createCustomerJourneyService,customerJourneySql} from '../oracle/customer-journey.js';
import {retentionBigQueryFixture} from '../test/helpers/retention-bigquery-sql-fixture.js';
import {retentionMappingReviewSql} from './retention-mapping-review.js';
export async function combinedValidationArtifact(){
 const project='gf-full-data',identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
 const cases=await retentionValidationCases();
 for(const group of ['retention_windows','retention_piece_windows','retention_baseline_windows']){
  let captured;const bigquery={query:async q=>{if(q.query.includes('retention_members')){captured=q;return [[]];}if(q.query.startsWith('SELECT state,'))return [[{state:'ready',start_date:'1900-01-01',end_date:'2026-10-19',mapping_count:3}]];return [[...['ww','usd','shopify'].map(source_store=>({source_store,identified_profiles:1,mapped_profiles:1,unmatched_profiles:0,qualifying_orders:1,matched_orders:1,unmatched_orders:0,ambiguous_orders:0,unavailable_orders:0,email_linked_guest_or_unknown_records:0,conflicting_orders:0,shared_address_orders:0}))]];}};
  await createCustomerJourneyService({bigquery,project,env:{ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:identity.dataset,ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:identity.snapshot}}).analyzeCustomerJourney({cohort_entry_start:'2022-10-19',cohort_entry_end:'2026-10-19',observation_end:'2026-10-19',time_zone:'Europe/London',first_order_semantic:'first_observed_ever',cohort:{entry_source:null,entry_product_classification:group==='retention_baseline_windows'?null:'collaboration'},group_by:[group],ranking_window:90,limit:group==='retention_baseline_windows'?3:99},{combined:true});
  cases.push({source:'tgf',store:'combined',group,full_select:{params:captured.params,types:captured.types,useLegacySql:false,location:'US',maximumBytesBilled:'20000000000',query:customerJourneySql(project,group,null,null,identity,true),jobTimeoutMs:180000},synthetic:retentionBigQueryFixture(group,'woo','ww',true)});
 }
 const strip=s=>s.replace(/^import .*;\n/gm,'');
 const helpers=['../oracle/retention-provisional.js','../oracle/retention-product-evidence.js','../oracle/retention-population.js'].map(p=>strip(readFileSync(new URL(p,import.meta.url),'utf8')).split('export function combinedRetentionSql')[0]).join('\n');
 const normalizer=readFileSync(new URL('../oracle/cohort-retention.js',import.meta.url),'utf8').split('export function retentionRows')[1].split('\nconst display=')[0];
 return {project,snapshot:identity.snapshot,cases,mapping_sql:retentionMappingReviewSql(project),validation_source:helpers+'\nexport function retentionRows'+normalizer,
 runner_source:readFileSync(new URL('./validate-retention-combined.js',import.meta.url),'utf8'),
 retained_source:readFileSync(new URL('./retention-current-evidence.js',import.meta.url),'utf8'),mapping_source:readFileSync(new URL('./retention-mapping-review.js',import.meta.url),'utf8').split('export function mappingReviewList')[1]};
}
if(process.argv[1]===new URL(import.meta.url).pathname){writeFileSync(new URL('./retention-combined-validation.json.gz',import.meta.url),gzipSync(JSON.stringify(await combinedValidationArtifact()),{mtime:0}));console.log('Built 9 source + 3 combined linked query shapes and one consolidated mapping inventory.');}

import test from 'node:test';
import assert from 'node:assert/strict';
import {customerJourneySql,createCustomerJourneyService} from '../oracle/customer-journey.js';
import {retentionRows} from '../oracle/cohort-retention.js';
import {cohortExecutionOptions,cohortRelations} from '../oracle/cohort-execution.js';
import {fixtureRetention,fixtureRetentionSections} from './helpers/retention-events.js';
const events=Array.from({length:240},(_,i)=>({source_platform:'woo',source_store:'ww',customer:'c'+i,order:'o'+i,timestamp:'2024-01-01T12:00:00Z',pieces:[{id:String(i),title:'Item '+i,names:['alpha'],group:'collaboration'}]}));
const definition={start_date:'2022-10-19',end_date:'2026-10-19',cohort_entry_start:'2022-10-19',cohort_entry_end:'2026-10-19',observation_end:'2026-10-19',time_zone:'Europe/London',group_by:['retention_piece_windows'],cohort:{entry_source:'woo'},limit:99};
const args={...definition,entry_source:'woo',ranking_window:90,coverage_status:'unverified'};
const base=fixtureRetention(events,args,{pieces:true});
const shared={coverage:base[0].coverage,entry_platform_rows:Array.from({length:300},(_,i)=>({source_platform:'woo',source_store:'ww',collaboration_name:'alpha',entry_product_ref:'p'+i,window_days:90,cohort_customers:1,provisional_eligible_customers:1,provisional_repeat_customers:0})),product_ranking_rows:fixtureRetentionSections(events,args)};
function fixture(compact){
 const rows=base.map((r,i)=>({...structuredClone(r),cohort_rank:Math.floor(i/3)+1,...(compact?{coverage:[],entry_platform_rows:[],product_ranking_rows:[]}:structuredClone(shared))}));
 if(compact)Object.assign(rows[0],structuredClone(shared));rows.push(rows.shift()); // Header arrives on the last page.
 let pages=0,submitted=0,cancelled=0,settings;
 const bigquery={query:async()=>{throw Error('Expected allocated query transport');},createQueryJob:async q=>{submitted++;settings=q;return[{id:'fixture-item-job',getQueryResults:async options=>{pages++;const offset=Number(options.pageToken||0),page=rows.slice(offset,offset+250),next=offset+250<rows.length?{pageToken:String(offset+250)}:null;return[page,next,{jobComplete:true}];},cancel:async()=>{cancelled++;}}];}};
 return{rows,bigquery,stats:()=>({pages,submitted,cancelled,settings})};
}
test('compact item metadata survives result pagination and preserves every calculation',async()=>{
 const old=fixture(false),compact=fixture(true);const read=async f=>createCustomerJourneyService({project:'fixture',bigquery:f.bigquery,env:{}}).analyzeCustomerJourney(definition,{sourceStore:'ww',completeItems:true});
 const [before,after]=await Promise.all([read(old),read(compact)]);
 assert.equal(after.results.length,720);assert.deepEqual(retentionRows(after.results,'repeat_rate_desc',90,6000),retentionRows(before.results,'repeat_rate_desc',90,6000));
 for(const key of ['item_completeness','classification_coverage','product_ranking_rows'])assert.deepEqual(after[key],before[key]);
 assert.equal(after.item_completeness.complete,true);assert.equal(after.product_ranking_rows.length,shared.product_ranking_rows.length);
 const bytesBefore=Buffer.byteLength(JSON.stringify(old.rows)),bytesAfter=Buffer.byteLength(JSON.stringify(compact.rows));assert.ok(bytesAfter<bytesBefore/10,`${bytesBefore} -> ${bytesAfter}`);
 assert.deepEqual({pages:compact.stats().pages,submitted:compact.stats().submitted,cancelled:compact.stats().cancelled},{pages:3,submitted:1,cancelled:0});
 assert.equal(compact.stats().settings.jobTimeoutMs,45000);assert.equal(compact.stats().settings.scriptOptions.statementTimeoutMs,'15000');assert.equal(compact.stats().settings.params.limit,6000);
});
test('only item projections compact shared arrays; per-window return products and linked scope remain',()=>{
 for(const [source,store,combined] of [['woo','ww',false],['woo','usd',false],['shopify','shopify',false],[null,null,true]]){
 const identity=combined?{dataset:'customer_identity',snapshot:'fixture',orderLinks:true}:null;
 const sql=customerJourneySql('fixture','retention_piece_windows',source,store,identity,combined),result=cohortRelations(sql).result;
 assert.match(result,/IF\(r.cohort_rank IS NULL OR \(r.cohort_rank=1 AND r.window_days=90\),ARRAY\(/);assert.match(result,/,\[\]\) product_ranking_rows/);assert.match(result,/c.coverage,\[\]\) coverage/);
 assert.match(result,/IFNULL\(p.second_order_products,\[\]\)/);assert.match(result,/second_order_product_coverage/);assert.match(sql,/total_item_window_rows/);
 if(combined){assert.match(result,/,\[\]\) entry_platform_rows/);assert.match(result,/'linked_tgf' population_scope/);}
 const settings=cohortExecutionOptions(sql,45000);assert.equal(settings.scriptOptions.statementTimeoutMs,'15000');assert.equal(settings.jobTimeoutMs,45000);
 }
 for(const group of ['retention_windows','retention_baseline_windows'])assert.doesNotMatch(cohortRelations(customerJourneySql('fixture',group)).result,/r.cohort_rank IS NULL/);
});

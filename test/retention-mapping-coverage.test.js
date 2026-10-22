import test from 'node:test';
import assert from 'node:assert/strict';
import {mappingAuditSql,mappingCoverageArtifact,readMappingCoverageEvidence,evidenceReaderSource,ingestionEvidenceQueries} from '../diagnostics/retention-mapping-coverage-evidence.js';
import {mappingReviewList,retentionMappingReviewSql} from '../diagnostics/retention-mapping-review.js';
import {retentionLimitEvidence,retentionLimitSummary} from '../oracle/retention-limits.js';
import {cohortExecutionPlan} from '../oracle/cohort-execution.js';
import {gunzipSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
test('review tests consumed source classifications, includes historical eligible lines and never invents title routes',()=>{
 const sql=retentionMappingReviewSql('fixture');
 assert.match(sql,/LOGICAL_OR\(EXISTS\(SELECT 1 FROM UNNEST\(l.classifications\)/);
 assert.match(sql,/WHERE NOT i.named_classification_consumed/);
 assert.doesNotMatch(sql,/AND \(l.family_status='ambiguous_family' OR NOT EXISTS/);
 assert.match(sql,/AND NOT \(\('product_group=core' IN UNNEST\(l.classifications\)/);assert.match(sql,/historical_eligible_orders/);assert.match(sql,/classification_conflicts/);assert.match(sql,/required_governance_action/);assert.match(sql,/JOIN targets t USING\(sku\)/);
 assert.doesNotMatch(sql,/LIKE.*title|published_at|is_archived|deleted_at/);
 const out=mappingReviewList([{source_product_id:'1',affected_customers:9,classification_conflicts:['collaboration_name'],candidates:[{product_ref:'shopify:shopify:2'},{product_ref:'shopify:shopify:3'}]}]);
 assert.equal(out.items[0].proposed_target,null);assert.equal(out.items[0].conflicts.length,2);assert.equal(out.governance_written,false);
});
test('catalogue reconciliation, review inventory and route-consumption audit have independent projections and staged inputs',()=>{
 const artifact=mappingCoverageArtifact('fixture'),q=mappingAuditSql('fixture');
 assert.match(q,/review_rows/);assert.match(q,/resolved_classification_not_consumed/);
 assert.equal((q.match(/SELECT AS STRUCT '(?:woo|shopify)' source_platform/g)||[]).length,3);
 assert.match(q,/LIMIT 501\) review_rows/);assert.doesNotMatch(q,/LIMIT 501\) catalogue/);
 assert.match(artifact.mapping_settings.query,/^BEGIN TRANSACTION;/);
 assert.equal(artifact.mapping_settings.maximumBytesBilled,'5500000000');assert.equal(artifact.mapping_settings.jobTimeoutMs,50000);
 assert.doesNotMatch(artifact.mapping_settings.query,/CREATE (?:OR REPLACE )?TABLE|INSERT INTO|MERGE INTO|DELETE FROM/);
 assert.equal((artifact.mapping_settings.query.match(/CREATE TEMP TABLE/g)||[]).length,10);
 assert.equal(ingestionEvidenceQueries('fixture').length,5);assert.ok(ingestionEvidenceQueries('fixture').every(x=>!x.query.includes('identity_snapshots')));
});
function envelope(){return {review_rows:[{source_product_ref:'woo:ww:17',source_product_id:'17',woo_title:'Archived item',affected_orders:6,affected_customers:5,total_review_products:1,candidates:[{product_ref:'shopify:shopify:9'}],classification_conflicts:[]}],catalogue:[['woo','ww'],['woo','usd'],['shopify','shopify']].flatMap(([source_platform,source_store])=>Array.from({length:25},(_,i)=>({source_platform,source_store,collection_id:String(i),display_name:'Governed '+i,collaboration_name:i?'name_'+i:'collaborations',products:1,observed_eligible_customers:0,historical_products:0,persisted_members:1,source_routes:0,historical_routed_products:0}))),route_consumption:[]};}
test('one failed ingestion read preserves consolidated review and every governed collection; missing evidence stays unknown (mock)',async()=>{
 const artifact=mappingCoverageArtifact('fixture');let reads=0;
 const result=await readMappingCoverageEvidence({project:'fixture',artifact,bigquery:{query:async q=>{reads++;if(q.query.includes('finance_refresh_runs'))throw Error('fixture unavailable');if(q.query.startsWith('BEGIN'))return [[envelope()]];return [[{matching_records:0}]];}}});
 assert.equal(reads,7);assert.equal(result.checks.length,7);
 const review=result.checks.find(c=>c.check==='consolidated_mapping_review');assert.equal(review.status,'read_completed');assert.equal(review.items[0].proposed_target,'shopify:shopify:9');assert.equal(review.catalogue.length,75);assert.ok(review.catalogue.every(c=>c.eligible_customers===null));assert.equal(result.coverage_certified,false);assert.equal(result.report_replayed,false);
});
test('independent main limits identify item truncation without implying missing collaborations, ranking or catalogue',()=>{
 const e={truncated:true,source_outcomes:[['retention_windows',54,99,false],['retention_piece_windows',99,99,true],['retention_baseline_windows',3,3,false]].map(([group,returned_rows,row_limit,truncated])=>({group,returned_rows,row_limit,truncated,state:'fulfilled',source_store:'combined'})),section_outcomes:[{component:'product_ranking_rows',state:'fulfilled',source_store:'combined'}],product_ranking_rows:Array.from({length:60},()=>({source_store:'combined'})),catalogue_reconciliation:Array(25).fill({})};
 const limits=retentionLimitEvidence(e);assert.equal(limits.filter(l=>l.status==='truncated').length,1);assert.match(retentionLimitSummary(e),/Individual collaboration items\/families \(99\/99/);assert.doesNotMatch(retentionLimitSummary(e),/additional collaborations/);assert.equal(limits.find(l=>l.section.startsWith('Whole-range')).status,'within_bound');assert.equal(limits.find(l=>l.section.startsWith('Governed')).returned,25);
 assert.match(retentionLimitSummary({truncated:true}),/legacy.*without identifying/i);
});
test('pinned review artifact matches factory and portable runner parses without imports',async()=>{
 const artifact=JSON.parse(gunzipSync(readFileSync(new URL('../diagnostics/retention-mapping-coverage.json.gz',import.meta.url))));assert.deepEqual({...artifact,runner_source:undefined},{...mappingCoverageArtifact('gf-full-data'),runner_source:undefined});
 const mod=await import('data:text/javascript;base64,'+Buffer.from(evidenceReaderSource()).toString('base64'));assert.equal(typeof mod.evidenceReader,'function');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseCohortProviders} from '../diagnostics/oracle-cohort-providers.js';
import {normalizeClassificationRef,classificationReaderCtes} from '../oracle/classification-reader.js';
import {classificationDiagnosticOptions,diagnoseClassificationCoverage} from '../diagnostics/oracle-classification-coverage.js';
import {createOracleProviderDependencies} from '../oracle/provider-dependencies.js';
import {categorySalesSql} from '../oracle/category-sales.js';
import {retentionCoverage,retentionDefinition,retentionMarkdown} from '../oracle/cohort-retention.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
const now=Date.parse('2026-10-19T12:00:00Z');
test('source keys retain Woo stores and reject variant identities as parent products',()=>{
 assert.equal(normalizeClassificationRef('woo:ww:42'),'woo:ww:42');
 assert.notEqual(normalizeClassificationRef('woo:ww:42'),normalizeClassificationRef('woo:usd:42'));
 assert.equal(normalizeClassificationRef('shopify:shopify:gid://shopify/Product/42'),'shopify:shopify:42');
 assert.equal(normalizeClassificationRef('shopify:shopify:gid://shopify/ProductVariant/42'),null);
});
test('real provider factory and category reader share current approved evidence and exclusions',async()=>{
 let query;const deps=createOracleProviderDependencies({project:'fixture',bigquery:{query:async q=>{query=q;return [[]];}}});
 const context=transitionAnalysisContext(null,'Rank collaborations by repeat purchase rate online in the last 3 years.',{now}).context;
 await deps.customerJourney.analyzeCustomerJourney({...retentionDefinition(context),cohort:{entry_source:'woo'}},{sourceStore:'usd',decompose:false});
 const shared=classificationReaderCtes('fixture');
 assert.ok(query.query.includes(shared));assert.ok(categorySalesSql('fixture').includes(shared));
 assert.match(shared,/cr_collection_current[\s\S]*ROW_NUMBER[\s\S]*c.status='active'/);
 assert.match(shared,/supersedes_classification_id/);assert.match(shared,/canonical_propagated/);
 assert.match(shared,/cr_identity i JOIN cr_family f ON f.source_ref=i.classification_ref/);
 assert.match(shared,/COUNTIF\(status='conflict'\)>0/);
 assert.doesNotMatch(query.query,/metorik_uk.orders|shopify_data.order_locations/);
 assert.match(query.query,/classification_stages/);assert.match(query.query,/classification_conflict=true/);
});
test('all diagnostic stages capture real factory joins with bounded PII-free outputs',async()=>{
 for(const [source,store] of [['woo','ww'],['woo','usd'],['shopify','shopify']])for(const stage of ['stages','gaps','identity','history','keys','catalogue']){
  const q=await classificationDiagnosticOptions({project:'fixture',source,store,stage,now});
  assert.equal(q.maximumBytesBilled,'20000000000');assert.equal(q.jobTimeoutMs,15000);
  assert.doesNotMatch(q.query,/retention_members AS/);assert.match(q.query,/LIMIT (?:3|20|100|200)$/);
  assert.doesNotMatch(q.query,/\b(?:INSERT|UPDATE|MERGE|CREATE|DELETE)\b/);
  assert.equal(q.params.observation_end.value,'2026-10-18');
 }
 const result=await diagnoseClassificationCoverage({project:'fixture',bigquery:{createQueryJob:async()=>{throw Object.assign(Error('private'),{code:403});}},now});
 assert.equal(result.state,'rejected');assert.equal(result.executed,false);assert.doesNotMatch(JSON.stringify(result),/private/);
});
test('stage coverage survives validation without converting unknown to core',()=>{
 const row={source_platform:'woo',source_store:'ww',eligible_first_customers:3,named_customers:1,generic_only_customers:0,unknown_customers:2,identified_orders:4,anonymous_orders:1,migrated_orders:0,excluded_orders:0,history_start:'2021-01-01',history_end:'2026-10-18',classification_stages:[{collaboration_state:'named',product_lines:1,customers:1},{collaboration_state:'classification_absent',product_lines:2,customers:2}]};
 assert.equal(retentionCoverage([row])[0].classification_stages[1].collaboration_state,'classification_absent');
 assert.throws(()=>retentionCoverage([{...row,classification_stages:[{collaboration_state:'core',product_lines:-1,customers:1}]}]));
});

test('visible cohort delivery retains explicit classification stage counts',()=>{const out=retentionMarkdown({rows:[],periods:[{start_date:'2023-10-19',end_date:'2026-10-18'}],observation_end:'2026-10-18',coverage:{classification:[{source_platform:'woo',source_store:'ww',classification_stages:[{collaboration_state:'classification_absent',product_lines:2,customers:2}]}]}});assert.match(out,/Classification Absent: 2 grouped order-product rows \/ 2 customers/);assert.match(out,/Customer counts overlap/);});

test('bounded channel diagnostic retains only supported source/channel populations',async()=>{const calls=[];const result=await diagnoseCohortProviders({project:'fixture',now,channel:'In-store',bigquery:{createQueryJob:async q=>{calls.push(q);return [{metadata:{}}];}}});assert.equal(calls.length,1);assert.equal(calls[0].params.entry_channel,'In-store');assert.equal(calls[0].params.subsequent_channel,'In-store');assert.equal(result.sources.filter(s=>s.state==='unsupported').length,2);assert.equal(result.sources[2].source_platform,'shopify');assert.deepEqual(result.unsupported_sources,['square']);});

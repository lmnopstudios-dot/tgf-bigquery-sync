import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {customerJourneySql} from '../oracle/customer-journey.js';
import {decomposedCohortSql,cohortRelations} from '../oracle/cohort-execution.js';
import {retentionRows} from '../oracle/cohort-retention.js';
import {retentionValidationCases} from '../diagnostics/build-retention-sql-validation.js';
const identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
const evidence=JSON.parse(readFileSync(new URL('./fixtures/retention-sql-15118146/locations.json',import.meta.url)));
// Reverse the ARRAY constructor fix and the two earlier source fixes, then verify every complete historical
// script hash captured before editing the factory. No SQL parser mock is claimed.
let source=readFileSync(new URL('../oracle/customer-journey.js',import.meta.url),'utf8');
source=source.replace('SELECT ARRAY(SELECT AS STRUCT * FROM (${retentionCatalogueSql(project)})) catalogue_reconciliation','SELECT ARRAY(${retentionCatalogueSql(project)}) catalogue_reconciliation');
source=source.replace("replace('SELECT r.*,IFNULL',()=>`","replace('SELECT r.*,IFNULL',`");
for(const k of ['missing_line_customers','unidentified_product_customers','untitled_product_customers'])source=source.replace(`COALESCE(pc.${k},0) AS ${k}`,`COALESCE(pc.${k},0) ${k}`);
source=source.replace(/from '([^']+)'/g,(_,p)=>`from '${new URL(p,new URL('../oracle/customer-journey.js',import.meta.url)).href}'`);
const historical=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
test('reconstruct exact linked 05b6aef scripts and reported positions across nine outcomes',()=>{
 for(const e of evidence){const old=decomposedCohortSql(historical.customerJourneySql('gf-full-data',e.group,e.source,e.store,identity));
  assert.equal(createHash('sha256').update(old).digest('hex'),e.sha256,`${e.store}/${e.group}`);
  const line=old.split('\n')[e.line-1];assert.equal(line,e.line_text);
  assert.ok(line.slice(e.column-1).startsWith(e.group==='retention_windows'?"r'^(?:gid://shopify/Product/)?([0-9]+)(p.second_order_products":"missing_line_customers"));
 }
});
test('literal catalogue regex and explicit STRUCT field aliases survive identity wrapping and decomposition',()=>{
 for(const e of evidence){const sql=customerJourneySql('gf-full-data',e.group,e.source,e.store,identity),script=decomposedCohortSql(sql);
  assert.match(script,/STRUCT\(COALESCE\(pc.missing_line_customers,0\) AS missing_line_customers,COALESCE\(pc.unidentified_product_customers,0\) AS unidentified_product_customers,COALESCE\(pc.untitled_product_customers,0\) AS untitled_product_customers\)/);
  if(e.group==='retention_windows'){assert.ok(script.includes("r'^(?:gid://shopify/Product/)?([0-9]+)$'"));assert.match(script,/catalogue_routes AS/);assert.match(script,/ORDER BY t.collection_id\)\) catalogue_reconciliation/);}
  assert.match(sql,/Identity snapshot integrity failed/);assert.match(sql,/LEFT JOIN ci_aliases/);assert.match(script,/NOT migrated/);assert.match(script,/BEGIN TRANSACTION/);assert.match(script,/COMMIT TRANSACTION/);
  assert.ok(cohortRelations(sql).relations.some(r=>r.name==='ci_mapping'));
 }
});
test('all validation artifacts use actual linked service SQL and independent synthetic executions',async()=>{
 const cases=await retentionValidationCases();assert.equal(cases.length,9);
 for(const c of cases){assert.equal(c.full_select.query,customerJourneySql('gf-full-data',c.group,c.source,c.store,identity));assert.equal(c.transaction_script.query,decomposedCohortSql(c.full_select.query));assert.match(c.full_select.query,/history-20261022-billing-v3/);assert.equal(c.full_select.params.coverage_status,'unverified');assert.equal(c.full_select.params.coverage_start,null);assert.equal(c.full_select.params.cohort_entry_start.value,'2022-10-19');assert.equal(c.full_select.params.observation_end.value,'2026-10-19');assert.doesNotMatch(c.synthetic.query,/`[^`]+`/);assert.equal(c.synthetic.types.within_days,'INT64');}
});

test('committed validation artifact exactly matches the service-generated SQL',async()=>{
 const {gunzipSync}=await import('node:zlib');
 const artifact=JSON.parse(gunzipSync(readFileSync(new URL('../diagnostics/retention-sql-validation.json.gz',import.meta.url))));
 assert.equal(JSON.stringify(artifact.cases),JSON.stringify(await retentionValidationCases()));
});

test('validation runner separates dry runs/execution and preserves independent failures (mocked transport)',async()=>{
 const {validateRetentionSql}=await import('../diagnostics/validate-retention-generated-sql.js');
 const cases=await retentionValidationCases(),requests=[];
 const bigquery={createQueryJob:async q=>{requests.push(q);assert.equal(q.dryRun,true);return [{metadata:{statistics:{totalBytesProcessed:'0'}}}];},query:async q=>{
  requests.push(q);assert.equal(q.dryRun,undefined);
  if(q.params.entry_source==='woo'&&q.params.retention_source_store==='ww')throw Object.assign(Error('isolated synthetic failure'),{code:400});
  const rows=[90,180,360].map(window_days=>({source_platform:q.params.entry_source,source_store:q.params.retention_source_store,collaboration_name:'alpha',cohort_customers:1,mature_customers:q.params.coverage_status==='verified_continuous'?1:0,repeat_customers:q.params.coverage_status==='verified_continuous'?1:0,observed_repeat_customers:1,window_days,observation_coverage_status:q.params.coverage_status,coverage_evidence:q.params.coverage_evidence,verified_coverage_start:q.params.coverage_start,verified_coverage_end:q.params.coverage_end,median_days_to_second:q.params.coverage_status==='verified_continuous'?14:null,second_order_products:[],second_order_product_coverage:{missing_line_customers:0,unidentified_product_customers:1,untitled_product_customers:0},catalogue_reconciliation:[{}],product_ranking_rows:[{}],baseline_period_rows:[{}]}));return [rows];
 }};
 const r=await validateRetentionSql({bigquery,artifact:{cases},validateRows:retentionRows});assert.equal(requests.length,36);assert.equal(r.checks.filter(c=>c.status==='failed').length,6);assert.equal(r.checks.filter(c=>c.status==='execution_and_result_validation_passed').length,12);assert.equal(r.checks.filter(c=>c.status==='dry_run_validated').length,18);assert.equal(r.production_transactions_executed,false);assert.equal(requests.filter(q=>q.dryRun&&q.jobTimeoutMs===60000).length,9);assert.equal(requests.filter(q=>q.dryRun&&q.jobTimeoutMs===10000).length,9);
});

test('merged #374 ARRAY failure at linked 147:8 and synthetic 69:8 is fixed without changing catalogue record fields',async()=>{
 const cases=await retentionValidationCases();
 const {retentionCatalogueSql}=await import('../oracle/retention-catalogue.js');
 for(const c of cases.filter(c=>c.group==='retention_windows')){
  for(const [kind,line] of [['full_select',147],['synthetic',69]]){
   const fixed=c[kind].query;
   const broken=fixed.replace('ARRAY(SELECT AS STRUCT * FROM (','ARRAY(').replace('ORDER BY t.collection_id)) catalogue_reconciliation','ORDER BY t.collection_id) catalogue_reconciliation');
   assert.equal(broken.split('\n')[line-1].slice(7,13),'ARRAY(');
   assert.match(broken,/ARRAY\(WITH catalogue_targets AS/);
   assert.match(fixed,/ARRAY\(SELECT AS STRUCT \* FROM \(WITH catalogue_targets AS/);
   // Projection star preserves all catalogue field names, including route evidence.
   assert.ok(fixed.includes(retentionCatalogueSql(kind==='synthetic'?'fixture':'gf-full-data').replaceAll('`fixture.shopify_catalogue.collections`','fixture_collections').replaceAll('`fixture.shopify_catalogue.product_collections`','fixture_product_collections')));
   assert.match(fixed,/historical_routed_products/);assert.match(fixed,/unclassified_products/);
  }
 }
});

test('one complete live acceptance request resolves the preserved report scope',async()=>{
 const {transitionAnalysisContext}=await import('../oracle/analysis-context.js');
 const question=readFileSync(new URL('./fixtures/collaboration-retention-complete-acceptance.txt',import.meta.url),'utf8');
 const c=transitionAnalysisContext(null,question,{now:Date.parse('2026-10-22T12:00:00Z')}).context;
 assert.equal(c.journey_group_by,'collaboration_piece');assert.equal(c.retention_baseline,true);assert.equal(c.retention_second_products,true);assert.equal(c.start_date,'2022-10-19');assert.equal(c.end_date,'2026-10-19');assert.equal(c.observation_end,'2026-10-19');assert.equal(c.time_zone,'Europe/London');
});

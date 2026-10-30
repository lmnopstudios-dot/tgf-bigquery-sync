import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateJourneyScope,requestedJourneyScope,journeyScopeText,assertJourneyScopeEvidence} from '../oracle/journey-scope.js';
import {customerJourneySql,validateJourneyDefinition} from '../oracle/customer-journey.js';
import {cohortRelations,cohortExecutionOptions} from '../oracle/cohort-execution.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {analyticalPlanKey,resolveAnalyticalPlan} from '../oracle/analytical-plan.js';
import {productJourneyDefinition,validateProductJourneys} from '../oracle/product-journeys.js';
import {collaborationJourneyDefinition} from '../oracle/collaboration-product-journeys.js';
import {retentionDefinition,retentionRows} from '../oracle/cohort-retention.js';
import {squareExtensionConfiguration,squareExtensionGuard} from '../oracle/square-reporting-extension.js';
import {linkedObservationCoverage} from '../oracle/observation-coverage.js';
import {squareChannelSqlFixture} from './helpers/square-channel-sql-fixture.js';
const scope=(entry='all',followup='all',next='anywhere_then_filter')=>({version:'square_channels_v1',include_square:true,entry,followup,next});
const identity={dataset:'identity',snapshot:'fixture',mode:'email_candidate_v2',orderLinks:true};
const python=spawnSync('python3',['-c','import duckdb,sqlglot'],{encoding:'utf8',timeout:5000}).status===0;
const query=(s,group='retention_product_journeys')=>customerJourneySql('fixture',group,null,null,identity,true,s,{state:'preview'});
function sqlFixture(s,options){
 const dir=mkdtempSync(join(tmpdir(),'square-channel-test-')),path=join(dir,'fixture.json');
 try{writeFileSync(path,JSON.stringify(squareChannelSqlFixture(s,options)));const r=spawnSync('python3',[new URL('./square-channel-sql.py',import.meta.url).pathname,path],{encoding:'utf8',timeout:30000,maxBuffer:5000000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}finally{rmSync(dir,{recursive:true,force:true});}
}

test('channel scope validation and role parsing separate entry, follow-up and order-selection semantics',()=>{
 assert.throws(()=>validateJourneyScope({...scope(),unexpected:true}));assert.throws(()=>validateJourneyScope({...scope(),entry:'pos'}));
 const first=requestedJourneyScope('Include Square. Customers introduced in-store—what did they buy next anywhere?');
 assert.deepEqual(first,scope('instore','all'));
 assert.deepEqual(requestedJourneyScope('Include Square. Online first purchases followed by in-store purchases.'),scope('online','instore'));
 assert.deepEqual(requestedJourneyScope('next in-store purchase',first),scope('instore','instore','next_matching_channel'));
 assert.deepEqual(requestedJourneyScope('next purchase anywhere, if in-store',first),scope('instore','instore'));
 assert.match(journeyScopeText(first),/Entry-purchase channel: In-store only/);assert.match(journeyScopeText(first),/Follow-up purchase channel: All supported/);
});

test('conversations retain independent controls across refinements and clear them on a subject switch',()=>{
 let c=transitionAnalysisContext({},'Most popular second-purchase products from 2024-01-01 to 2024-12-31. Include Square. Entry channel: in-store. Follow-up channel: all channels.').context;
 assert.equal(c.journey_intent,'second_purchase_products');assert.deepEqual(c.journey_scope,scope('instore','all'));
 const d=productJourneyDefinition(c);assert.equal(d.cohort.entry_channel,'In-store');assert.equal(d.subsequent.channel,null);validateJourneyDefinition(d);
 const key=analyticalPlanKey(resolveAnalyticalPlan(c));
 c=transitionAnalysisContext(c,'Next in-store purchase.').context;
 assert.deepEqual(c.journey_scope,scope('instore','instore','next_matching_channel'));assert.notEqual(key,analyticalPlanKey(resolveAnalyticalPlan(c)));
 const switched=transitionAnalysisContext(c,'Show Shopify sales in 2025.').context;assert.equal(switched.journey_scope,null);
 for(const [message,definition]of [['Collaboration retention in 2024. Include Square. Online first purchases followed by in-store purchases.',retentionDefinition],['What products did customers buy next after their first collaboration purchase in 2024? Include Square. Entry channel: in-store. Follow-up channel: all channels.',collaborationJourneyDefinition]]){
  const c=transitionAnalysisContext({},message).context;const d=definition(c);assert.ok(d.report_scope);validateJourneyDefinition(d);
 }
});

test('Square requires a separate reviewed marker tied to the accepted snapshot; no publication or default activation',()=>{
 assert.equal(squareExtensionConfiguration({}),null);
 assert.throws(()=>squareExtensionGuard('fixture',identity,null));
 const ext=squareExtensionConfiguration({ORACLE_SQUARE_REPORTING_VERSION:'square_channels_v1',ORACLE_SQUARE_REPORTING_EXTENSION_ID:'review-one'});
 const g=squareExtensionGuard('fixture',identity,ext);assert.match(g,/identity_reporting_extensions/);assert.match(g,/base_snapshot='fixture'/);assert.match(g,/state='reviewed'/);
 for(const group of ['retention_windows','retention_product_journeys','retention_collaboration_journeys']){
  const old=customerJourneySql('fixture',group,null,null,identity,true);assert.doesNotMatch(old,/sx_links|square_data|reporting_coverage/);
  const q=query(scope(),group),r=cohortRelations(q);assert.ok(r.relations.findIndex(r=>r.name==='sx_links')<r.relations.findIndex(r=>r.name==='ranked_orders'));
  assert.match(r.relations.find(r=>r.name==='qualifying_orders').body,/s.identity_ref/);
  assert.match(r.relations.find(r=>r.name==='entry_orders').body,/order_sequence=1/);
  const o=cohortExecutionOptions(q,45000);const statements=(o.query.match(/CREATE TEMP TABLE/g)||[]).length;
  assert.ok(BigInt(o.maximumBytesBilled)*BigInt(statements)<=20000000000n);
  assert.doesNotMatch(o.query,/CREATE OR REPLACE|INSERT INTO|UPDATE |MERGE |identity_order_links`\s*SET/);
 }
});

test('all source coverage certificates are required, even when the follow-up channel is restricted',()=>{
 const certificates=[['woo','ww'],['woo','usd'],['shopify','shopify']].map(([source_platform,source_store])=>({source_platform,source_store,status:'verified_continuous',start:'2024-01-01',end:'2025-01-01',time_zone:'UTC',evidence:'fixture'}));
 assert.equal(linkedObservationCoverage(certificates,'UTC').status,'verified_continuous');
 assert.equal(linkedObservationCoverage(certificates,'UTC',true).status,'unverified');
 assert.equal(linkedObservationCoverage([...certificates,{...certificates[0],source_platform:'square',source_store:'square'}],'UTC',true).status,'verified_continuous');
});

for(const next of ['anywhere_then_filter','next_matching_channel'])test('generated SQL: online entry followed by in-store, '+next,{skip:!python},()=>{
 const result=sqlFixture(scope('online','instore',next))[0];
 validateProductJourneys(result.product_journeys);
 const overall=result.product_journeys.find(r=>r.entry_product_ref===null&&r.window_days===0);
 assert.equal(overall.entry_customers,1); // C only; A/B/D/T have earlier history, Woo E is outside entry dates.
 assert.equal(overall.returning_customers,next==='next_matching_channel'?1:0);
 assert.ok(result.reporting_coverage.some(r=>r.source_platform==='square'&&r.channel==='Unknown'));
 assert.ok(result.reporting_coverage.some(r=>r.source_platform==='square'&&r.ambiguous_lines===1));
});

test('generated SQL: in-store introduced, next anywhere retains unmatched identities and unknown product attribution',{skip:!python},()=>{
 const result=sqlFixture(scope('instore','all'))[0];validateProductJourneys(result.product_journeys);
 const overall=result.product_journeys.find(r=>r.entry_product_ref===null&&r.window_days===0);
 assert.equal(overall.entry_customers,5);assert.equal(overall.returning_customers,4);
 assert.equal(overall.products.find(p=>p.family_status==='governed_family').customers,3);
 assert.equal(overall.products.find(p=>p.family_status==='unmapped_item').customers,1);
 assert.ok(result.product_journeys.every(r=>r.verified_customers===0&&r.verified_repeat_customers===0));
 const coverage=result.reporting_coverage.find(r=>r.source_platform==='square'&&r.channel==='In-store');
 assert.equal(coverage.anonymous_orders,0);assert.equal(coverage.unidentifiable_orders,2);assert.equal(coverage.eligible_orders,11);assert.equal(coverage.eligible_transaction_orders,13); // duplicate source and view revisions counted once
 assert.equal(coverage.mapped_lines,8);assert.equal(coverage.ambiguous_lines,1);
});

test('generated SQL: collaboration entry uses governed classes, missing and ambiguous mappings do not infer membership',{skip:!python},()=>{
 const result=sqlFixture(scope('instore','all'),{group:'retention_collaboration_journeys'})[0];
 const overall=result.collaboration_journeys.find(r=>r.cohort_type==='overall'&&r.window_days===0);
 assert.equal(overall.entry_customers,3);assert.equal(overall.returning_customers,3); // A,E,T; unclassified U and ambiguous AMB excluded
 assert.ok(!result.collaboration_journeys.some(r=>/Alpha collaboration ring/.test(r.entry_product)));
 assert.equal(result.available_collaborations,1);
});

test('generated SQL: all/online/store filters follow combined first assignment; migration copy and tied-time orders excluded',{skip:!python},()=>{
 const ranked=sqlFixture(scope('all','all'),{terminal:'SELECT source_platform,order_ref,governed_customer_ref,order_timestamp,order_sequence,channel FROM ranked_orders'});
 assert.equal(ranked.filter(r=>r.order_ref==='qa').length,1);assert.ok(!ranked.some(r=>r.order_ref==='import'));
 assert.equal(ranked.find(r=>r.order_ref==='qb').order_sequence,2);
 assert.equal(ranked.find(r=>r.order_ref==='wa').order_sequence,2);
 assert.ok(!ranked.some(r=>r.order_ref==='qg'||r.order_ref==='qg2')); // no anonymous Square order is invented as a customer
 assert.equal(ranked.find(r=>r.order_ref==='qu').governed_customer_ref,ranked.find(r=>r.order_ref==='qu2').governed_customer_ref);
 assert.notEqual(ranked.find(r=>r.order_ref==='qe').governed_customer_ref,ranked.find(r=>r.order_ref==='we').governed_customer_ref);
 const next=sqlFixture(scope(),{terminal:'SELECT order_ref FROM retention_next_orders'});assert.ok(next.some(r=>r.order_ref==='qt2'));assert.ok(!next.some(r=>r.order_ref==='wt'));
});

test('scope proof rejects changed channel, selection mode, extension and missing attribution coverage',()=>{
 const c={journey_scope:scope()},e={definition:{report_scope:scope()},identity_evidence:{snapshot:'fixture',reporting_extension:{version:'square_channels_v1',base_snapshot:'fixture',state:'reviewed',identity_version:'square_native_email_v1',id:'fixture-review'}},reporting_coverage:[]};
 assertJourneyScopeEvidence(c,e);
 for(const mutate of [x=>x.definition.report_scope.entry='online',x=>x.definition.report_scope.next='next_matching_channel',x=>delete x.reporting_coverage,x=>x.identity_evidence.reporting_extension.base_snapshot='another',x=>x.identity_evidence.reporting_extension.identity_version='wrong']){const bad=structuredClone(e);mutate(bad);assert.throws(()=>assertJourneyScopeEvidence(c,bad));}
 const evidence=JSON.parse(readFileSync(new URL('./fixtures/square-reporting-400-evidence.json',import.meta.url),'utf8'));
 assert.equal(evidence.summary.eligible_linked_square_ids,1524);assert.equal(evidence.summary.eligible_linked_square_orders,2026);
});

test('generated SQL: collaboration retention keeps provisional and verified rates separate with Square entry',{skip:!python},()=>{
 const raw=sqlFixture(scope('instore','all'),{group:'retention_windows'});const rows=retentionRows(raw);
 assert.equal(rows.length,3);
 for(const r of rows){assert.equal(r.cohort_customers,3);assert.equal(r.observed_repeat_customers,3);assert.equal(r.provisional_repeat_rate,1);assert.equal(r.repeat_rate,null);assert.equal(r.mature_customers,0);assert.equal(r.observation_coverage_status,'unverified');}
 assert.ok(raw[0].entry_platform_rows.every(r=>r.source_platform==='square'));
});

for(const [label,options,key] of [['unreconciled line',{missingPersistedFor:['qu2']},'unknown_product_customers'],['absent latest-order lines',{emptyPayloadFor:['qu2']},'missing_line_customers']])test(`generated SQL: ${label} keeps the return in the denominator and attribution unknown`,{skip:!python},()=>{
 const result=sqlFixture(scope('instore','all'),options)[0];validateProductJourneys(result.product_journeys);
 const overall=result.product_journeys.find(r=>r.entry_product_ref===null&&r.window_days===0);
 assert.equal(overall.returning_customers,4);assert.equal(overall[key],1);
 assert.equal(overall.products[0].customers,3);assert.equal(overall.products[0].denominator_customers,4);assert.equal(overall.products[0].percentage,75);
});

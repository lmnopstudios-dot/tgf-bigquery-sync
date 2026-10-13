import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { assertProductArtifact } from '../oracle/product-artifact-validation.js';
import { numericDistribution, minorUnits } from '../oracle/numeric-distribution.js';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { dispatchAnalysisRequest, assertEvidenceAgreement, executeGovernedAgentAnalysis } from '../oracle/analysis-route-dispatcher.js';
import { orderValueHistogramSql, orderValueCoverageSql } from '../oracle/order-value-provider.js';
import { validateOrderValueDiagnostic } from '../diagnostics/oracle-order-values.js';
import { fetchPublishedProducts } from '../oracle/product-priority.js';

const NOW=Date.parse('2026-10-13T10:00:00Z');
const PROMPT='Analyse UK online GBP order-value bands this year through the latest completed day. Current free shipping threshold £250; delivery £8 below. Compare thresholds £175, £200, £225, £275 and £300 under unchanged purchasing behaviour. Include add-on products.';
const context=()=>transitionAnalysisContext(null,PROMPT,{now:NOW}).context;
const rows=[{date:'2026-05-02',amount:200,shipping_charge:8,orders:2},{date:'2026-09-01',amount:225,shipping_charge:null,orders:1},{date:'2026-09-02',amount:249.99,shipping_charge:null,orders:1},{date:'2026-09-03',amount:250,shipping_charge:12,orders:1},{date:'2026-09-04',amount:null,shipping_charge:8,orders:1},{date:'2026-09-05',amount:350,shipping_charge:8,orders:1}];
function fixture({coverageFailure=false,priceFailure=false,populationFailure=false}={}){
  const calls=[];
  const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async o=>{calls.push(o);if(o.query.includes('GROUP BY 1,2,3')){if(populationFailure)throw Error('private');return [rows];}if(coverageFailure)throw Error('private');return [[{eligible_orders:7,missing_status:2,missing_financials:1}]];}};
  const deps=createOracleProviderDependencies({bigquery,project:'fixture',env:{}});
  const store={values:new Map(),async get(id,owner){return this.values.get(owner+id)||null;},async put(id,owner,value){this.values.set(owner+id,value);}};
  const baseline=createBaselineOverviewService({...deps,orderValues:deps.orderValues,productPrices:async()=>{if(priceFailure)throw Error('private');return {complete:true,products:[{product_id:'7',title:'Small pendant',product_type:'Pendant',destination_prices:[{variant_id:'v7',price:'25.00',currency:'GBP',country:'GB'}]}]};},socialExportStore:store,now:()=>new Date(NOW),knowledgeService:{searchKnowledge:async()=>({items:[{kind:'event',status:'confirmed',id:'may',title:'May online sale',content:'Online sale.',effective_from:'2026-05-01',effective_to:'2026-05-04',date_precision:'range',source_type:'human',source_reference:'fixture',tags:['online']}]})}});
  const run=c=>dispatchAnalysisRequest({message:PROMPT,analysisContext:c,baselineOverview:baseline,baselineOptions:{exportOwner:'owner',requestId:'r'},chat:()=>assert.fail('No model fallback')});
  return {calls,baseline,run,store};
}
test('weighted bands, exact thresholds, genuine zero and missing values, fee arithmetic',()=>{
  const r=numericDistribution([{amount:99.99,shipping_charge:8,orders:1},{amount:100,shipping_charge:8,orders:1},{amount:175,shipping_charge:0,orders:1},{amount:200,shipping_charge:5.25,orders:1},{amount:225,shipping_charge:null,orders:1},{amount:249.99,shipping_charge:8,orders:1},{amount:250,shipping_charge:0,orders:1},{amount:275,shipping_charge:8,orders:1},{amount:300,shipping_charge:8,orders:1},{amount:350,shipping_charge:8,orders:1},{amount:0,shipping_charge:0,orders:1},{amount:null,shipping_charge:8,orders:1}],{});
  assert.equal(r.population,12);assert.equal(r.unknown_values,1);assert.equal(r.bands[0].orders,2);assert.equal(r.bands[1].orders,1);assert.equal(r.bands.at(-1).orders,1);
  const lower=r.scenarios.find(s=>s.threshold===225);assert.equal(lower.newly_eligible,2);assert.equal(lower.recorded_shipping_charges,8);assert.equal(lower.unknown_charge_orders,1);assert.equal(lower.hypothetical_fee,16);
  const higher=r.scenarios.find(s=>s.threshold===275);assert.equal(higher.losing_eligibility,1);assert.equal(higher.recorded_shipping_charges,0);assert.equal(higher.zero_charge_orders,1);assert.equal(r.scenarios.find(s=>s.threshold===250).affected_orders,0);
  assert.equal(minorUnits('8.005'),801);assert.equal(minorUnits(null),null);assert.throws(()=>numericDistribution([{amount:5,orders:1.5}],{}));
});
test('production factory to shared context, planner, dispatcher, calculations and compact presentation',async()=>{
  const f=fixture(),c=context(),r=await f.run(c);
  assert.equal(r.evidence.sections[0].population,7);assert.equal(r.evidence.sections[0].unknown_values,1);assert.equal(c.end_date,'2026-10-12');assert.match(r.answer,/shipping-rule basis is unverified/);assert.match(r.answer,/Show details/);assert.equal(r.evidence.candidates[0].price,25);assert.equal(r.charts.length,1);assert.equal(r.evidence.coverage.complete,false);assert.equal(assertEvidenceAgreement(r.analysis_context,r.evidence),true);
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].location,'EU');assert.equal(f.calls[0].params.currency,'GBP');assert.equal(f.calls[0].params.country,'GB');assert.equal(f.calls[0].maximumBytesBilled,'1000000000');
  assert.doesNotMatch(f.calls[0].query,/original_subtotal_presentment\s*-\s*original_discounts|UNNEST.*line|JOIN.*order_refunds/);
  assert.match(f.calls[0].query,/NULLIF\(original_shipping_presentment,0\)/);assert.match(f.calls[0].query,/retail_location_id IS NULL/);assert.match(f.calls[0].query,/partially_refunded/);
  const direct=await executeGovernedAgentAnalysis({message:PROMPT,baselineOverview:f.baseline,now:NOW});assert.equal(direct.evidence.kind,'governed_order_values');
});
test('follow-ups preserve filters, amount basis and scenario; calendar exclusions recalculate denominator',async()=>{
  const f=fixture();let c=context();
  c=transitionAnalysisContext(c,'Try £225 instead.',{now:NOW}).context;assert.deepEqual(c.numeric_operation.thresholds,[225]);
  c=transitionAnalysisContext(c,'Exclude the May sale.',{now:NOW}).context;let r=await f.run(c);assert.equal(r.evidence.sections.length,2);assert.equal(r.evidence.sections[0].population,7);assert.equal(r.evidence.sections[1].population,5);assert.equal(r.evidence.sections[1].scenarios[0].newly_eligible,2);
  c=transitionAnalysisContext(c,'Just September.',{now:NOW}).context;assert.deepEqual([c.start_date,c.end_date],['2026-09-01','2026-09-30']);assert.equal(c.geography,'GB');assert.deepEqual(c.currencies,['GBP']);
  c=transitionAnalysisContext(c,'Show the order-value bands.',{now:NOW}).context;assert.deepEqual(c.numeric_operation.thresholds,[225]);
  c=transitionAnalysisContext(c,'Export that.',{now:NOW}).context;assert.equal(c.output_preference,'xlsx');
});
test('XLSX owner scoping, same evidence and idempotency; recovery rejects tampering',async()=>{
  const f=fixture(),c=transitionAnalysisContext(context(),'Export that.',{now:NOW}).context,r=await f.run(c);
  const saved=await f.store.get(r.artifact.id,'owner');assert.equal(await f.store.get(r.artifact.id,'other'),null);
  await assertProductArtifact(saved);await assert.rejects(assertProductArtifact({...saved,sha256:'wrong'}),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(saved.xlsx_base64,'base64'));assert.equal(wb.getWorksheet('Summary').rowCount,r.evidence.rows.length+1);assert.match(wb.getWorksheet('Definitions').getCell('B5').value,/shipping-rule/);
  const retry=await f.run(c);assert.equal(retry.artifact.id,r.artifact.id);assert.deepEqual(retry.evidence,saved.envelope);
  for(const mutate of [e=>e.operation.thresholds.push(123),e=>e.sections[0].population++,e=>e.source_rows[0].date='2025-01-01',e=>e.currency='USD',e=>e.promotion.dates.push('2026-05-01')]){const e=structuredClone(r.evidence);mutate(e);assert.throws(()=>assertEvidenceAgreement(r.analysis_context,e),err=>err.code==='EVIDENCE_SCOPE_MISMATCH');}
});
test('coverage and product failures retain numeric evidence; required retrieval failure is explicit',async()=>{
  for(const options of [{coverageFailure:true},{priceFailure:true}]){const r=await fixture(options).run(context());assert.equal(r.evidence.sections[0].population,7);assert.match(r.answer,/Threshold/);assert.doesNotMatch(JSON.stringify(r),/private/);}
  const r=await fixture({populationFailure:true}).run(context());assert.equal(r.evidence.retrieval_failed,true);assert.equal(r.evidence.sections.length,0);assert.match(r.answer,/could not be retrieved/);assert.ok(r.answer.trim());
});
test('SQL reduces duplicate components before monetary joins and uses governed eligibility without inferred history',()=>{
  const s=orderValueHistogramSql('fixture');assert.equal((s.match(/QUALIFY ROW_NUMBER/g)||[]).length,4);assert.match(s,/PARTITION BY order_id ORDER BY updated_at DESC,synced_at DESC/);assert.match(s,/shipping_country_code=@country AND presentment_currency=@currency/);assert.match(s,/cancelled_at IS NULL AND finance_cancelled_at IS NULL/);assert.match(s,/source_app_id!=@matrixify_app_id/);assert.doesNotMatch(s,/fully_refunded|inventory/);assert.match(s,/DATE\(l.created_at,'Europe\/London'\)/);assert.match(orderValueCoverageSql('fixture'),/missing_financials/);assert.throws(()=>orderValueHistogramSql('x;DROP'));
});
test('published destination-price enrichment uses shared product resolution and never inventory',async()=>{
  let query;
  const catalogue=await fetchPublishedProducts(async q=>{query=q;return {products:{nodes:[{id:'gid://shopify/Product/7',title:'Pendant',status:'ACTIVE',publishedAt:'2026-01-01',onlineStoreUrl:'https://example.com/products/pendant',productType:'Pendant',tags:[],collections:{nodes:[],pageInfo:{hasNextPage:false}},variants:{nodes:[{id:'v',contextualPricing:{price:{amount:'25.00',currencyCode:'GBP'}}}],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false}}};},{includeSeo:false,inspectClassification:true,destinationPrices:true,maxPages:7});
  assert.equal(catalogue.complete,true);assert.equal(catalogue.products[0].destination_prices[0].country,'GB');assert.match(query,/contextualPricing\(context:\{country:GB\}\)/);assert.doesNotMatch(query,/inventory|availableForSale/);
});
test('read-only diagnostics reject mutations, unbounded and invalid periods',()=>{
  for(const i of [{start:'2026-01-01',end:'2027-12-31'},{start:'2026-02-30',end:'2026-03-01'},{start:'2026-01-01',end:'2026-01-02',execute:'true'}])assert.throws(()=>validateOrderValueDiagnostic(i));
});

test('fresh order-value subject clears incompatible campaign/catalogue scopes; currency filters refine independently',()=>{
  const prior=transitionAnalysisContext(null,'Export all published Shopify products this year.',{now:NOW}).context;
  const c=transitionAnalysisContext(prior,PROMPT,{now:NOW}).context;assert.equal(c.product_report,null);assert.equal(c.campaign_request,null);assert.equal(c.entity_query,null);assert.equal(c.requested_subject,'order_values');
  const follow=transitionAnalysisContext(c,'Use US USD.',{now:NOW}).context;assert.equal(follow.geography,'US');assert.deepEqual(follow.currencies,['USD']);assert.deepEqual(follow.numeric_operation,c.numeric_operation);
  const fresh=transitionAnalysisContext(c,'Order-value bands for online USD orders.',{now:NOW}).context;
  // Without a destination instruction this is a compatible continuation.
  assert.equal(fresh.tool_route,'get_order_value_analysis');
});

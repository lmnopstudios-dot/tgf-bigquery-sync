import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { assertEvidenceAgreement } from '../oracle/analysis-route-dispatcher.js';
import { PRODUCT_REPORT_CAPABILITIES, productReportConfigKey, validateProductReportConfig } from '../oracle/product-report-config.js';
import { rankProductReport } from '../oracle/product-report-export.js';
const now=Date.parse('2026-10-06T12:00:00Z'),apply=(message,prior=null)=>transitionAnalysisContext(prior,message,{now}).context;
const catalogue={complete:true,products:[{product_id:'10',title:'Z',url:'https://shop.example/products/z'},{product_id:'2',title:'A',url:'https://shop.example/products/a'},{product_id:'3',title:'Missing',url:'https://shop.example/products/m'}]};
const source=rows=>({status:'available',complete:true,rows});

test('natural metric aliases share a validated configuration and preserve configuration through refinements',()=>{
  const c=apply('Export all products with units sold, orders and sales amounts for January–September 2026, sorted by units sold.');
  assert.deepEqual(c.product_report.metrics,['units_sold','product_orders','product_sales']);assert.deepEqual(c.product_report.period,{start_date:'2026-01-01',end_date:'2026-09-30',timezone:'Europe/London'});
  const add=apply('Add landings to that.',c),sort=apply('Sort by units sold instead.',add);assert.deepEqual(sort.product_report.period,c.product_report.period);assert.equal(sort.product_report.channel,'online');assert.ok(sort.product_report.metrics.includes('landing_sessions'));
  const limit=apply('Top 20 instead.',sort);assert.equal(limit.product_report.population.limit,20);assert.equal(apply('All products instead.',limit).product_report.population.limit,null);
  const ids=apply('Only product IDs 10, 2.',sort);assert.deepEqual(ids.product_report.population.product_ids,['2','10']);
  for(const [name,capability] of Object.entries(PRODUCT_REPORT_CAPABILITIES)){assert.equal(capability.name,name);assert.ok(capability.definition);assert.ok(capability.grain);assert.ok(capability.compatible_dimensions.includes('period'));if(capability.supported){assert.ok(capability.provider_binding.table);assert.ok(capability.provider_binding.field);}}
});
test('full report agreement includes columns/order, period, population, currency, sort, format and preset',()=>{
  const context=apply('Export products with units sold and sales this year sorted by units sold.'),evidence={kind:'product_report_export',subject:'product_report',metrics:['products'],periods:[context.product_report.period],report_config:context.product_report};assert.equal(assertEvidenceAgreement(context,evidence),true);
  const variants=[{metrics:['product_sales','units_sold']},{period:{...context.product_report.period,start_date:'2026-02-01'}},{population:{...context.product_report.population,limit:20}},{population:{...context.product_report.population,product_ids:['2']}},{currency:'USD'},{sort:{metric:'units_sold',direction:'asc'}},{priority_preset:'photography_content',sort:{metric:'priority',direction:'desc'}}];
  for(const changes of variants){const changed={...context.product_report,...changes};assert.notEqual(productReportConfigKey(changed),productReportConfigKey(context.product_report));assert.throws(()=>assertEvidenceAgreement(context,{...evidence,report_config:changed}),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');}
  for(const changes of [{channel:'instore'},{output_format:'csv'},{metrics:['fabricated']},{period:{start_date:'2026-02-30',end_date:'2026-03-01',timezone:'Europe/London'}},{population:{kind:'everything',product_ids:null,limit:null}},{sort:{metric:'product_sales',direction:'desc'},currency:null,unresolved:[]}])assert.throws(()=>validateProductReportConfig({...context.product_report,...changes}),e=>e.code==='INVALID_PRODUCT_REPORT_CONFIG');
});
test('units/orders totals are not inflated by currency rows; deterministic ties and missing-last in both directions',()=>{
  const c=apply('Export all products with units sold and orders this year sorted by units sold.').product_report,sources={sales:source([{product_id:'10',currency:'GBP',units_sold:5,product_orders:2},{product_id:'10',currency:'USD',units_sold:5,product_orders:2},{product_id:'2',currency:'GBP',units_sold:5,product_orders:1}])};
  const ranked=rankProductReport(catalogue,sources,c);assert.deepEqual(ranked.rows.map(r=>r.product_id),['2','10','3']);assert.equal(ranked.rows[1].metrics.units_sold,5);assert.equal(ranked.rows[1].metrics.product_orders,2);
  const asc=rankProductReport(catalogue,sources,{...c,sort:{metric:'units_sold',direction:'asc'}});assert.deepEqual(asc.rows.map(r=>r.product_id),['2','10','3']);
  const conflicted=rankProductReport(catalogue,{sales:source([...sources.sales.rows,{product_id:'10',currency:'EUR',units_sold:6,product_orders:2}])},c);assert.equal(conflicted.rows.find(r=>r.product_id==='10').metrics.units_sold,null);
});
test('validated unique URL joins reject ambiguity and origins while independent organic metrics preserve zero',()=>{
  const c=apply('Show products with organic clicks and impressions this year sorted by clicks.').product_report,result=rankProductReport(catalogue,{organic:source([{page:'https://shop.example/products/z?utm=1',clicks:0,impressions:null},{page:'https://other.example/products/a',clicks:100,impressions:100},{page:'https://shop.example/products/a',clicks:10,impressions:20}])},c);
  assert.deepEqual(result.rows.map(r=>r.product_id),['2','10','3']);assert.equal(result.rows[1].metrics.organic_clicks,0);assert.equal(result.rows[1].metrics.organic_impressions,null);
  const ambiguous={...catalogue,products:[...catalogue.products,{product_id:'11',title:'Duplicate',url:catalogue.products[0].url}]};const rejected=rankProductReport(ambiguous,{organic:source([{page:catalogue.products[0].url,clicks:500,impressions:500}])},c);assert.ok(rejected.rows.every(r=>r.metrics.organic_clicks==null));
});
test('unsupported metrics remain explicit capabilities and unknown requested columns require clarification',()=>{
  const unsupported=apply('Export products with net sales, net units sold, page views and refunds this year.').product_report;assert.deepEqual(unsupported.metrics,['net_sales','net_units','page_views','refunds']);assert.ok(unsupported.metrics.every(m=>!PRODUCT_REPORT_CAPABILITIES[m].supported));
  const unknown=transitionAnalysisContext(null,'Export products with sentiment scores this year.',{now});assert.equal(unknown.transition.ready_to_execute,false);assert.ok(unknown.context.product_report.unresolved.includes('metrics'));
  const dimension=transitionAnalysisContext(null,'Export product units sold by country this year.',{now});assert.equal(dimension.transition.ready_to_execute,false);assert.ok(dimension.context.product_report.unsupported_requirements.length);
});

test('report refinements preserve configuration while new subjects leave exports',()=>{
  const landing=apply('Export all published Shopify products in order of landing traffic only.');
  const add=apply('Add units sold and sales value to that sheet.',landing),sort=apply('Sort by units instead.',add),dates=apply('What about last year?',sort);
  assert.deepEqual(dates.product_report.metrics,['landing_sessions','units_sold','product_sales']);assert.equal(dates.product_report.sort.metric,'units_sold');assert.equal(dates.product_report.period.start_date,'2025-01-01');assert.equal(dates.product_report.period.end_date,'2025-12-31');
  const selected=apply('Only product IDs 10, 2.',sort),all=apply('All published Shopify products instead.',selected);assert.equal(all.product_report.population.product_ids,null);
  for(const message of ['Show mobile and desktop conversion rates this year.','Show sales for Pendant this year.','How have Klaviyo campaigns affected sales this year?'])assert.equal(apply(message,sort).product_report,null);
  assert.equal(transitionAnalysisContext(null,'Export top-selling products this year.',{now}).transition.ready_to_execute,false);
});

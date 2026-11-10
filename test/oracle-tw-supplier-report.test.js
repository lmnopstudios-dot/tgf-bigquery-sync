import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
import {createMemoryExportStore} from '../oracle/product-priority-storage.js';
import {createOracleBaselineDispatcher} from '../oracle/baseline-dispatcher.js';
import {buildTwWorkbookRows,createTwSupplierReportService} from '../oracle/tw-supplier-report.js';
import {twSalesSql} from '../oracle/tw-supplier-sales.js';
import {oracleRequestRoute} from '../public/oracle/request-routing.js';

const now=Date.parse('2026-11-10T12:00:00Z');
const long=`Build a Shopify sales and stock report for every variant of every product currently tagged exactly \`tw\`, case-insensitive. Include variants with no sales. Join by Shopify variant ID and show product, size/options and SKU.

Show units sold separately for Shopify Online Store and POS for these three periods, in Europe/London:
- 19–31 October 2026 (partial month)
- 1–4 November 2026
- 5–8 November 2026

Use the backfilled Shopify order lines. Show current available stock by location and combined, with workshop stock separate. Keep missing stock quantities blank rather than treating them as zero. Show historical month-end stock only if you have an actual snapshot.

Put variants with recent sales and low or zero available stock at the top. Show one row per variant. Keep any unmatched sales lines separate. If stock lookup is unsupported, return the sales rows anyway and explain what was unavailable. Use existing data only. Do not create knowledge records, change stock or place orders.`;
const vid=n=>'gid://shopify/ProductVariant/'+n, lid=n=>'gid://shopify/Location/'+n;
const context={start_date:'2025-11-01',end_date:'2026-10-31'};
const inventory={population:{catalogue_complete:true,locations_complete:true},locations:[{id:lid(1)},{id:lid(2)}],failures:[],
  products:[{title:'Fixture ring',variants:[1,2].map(n=>({id:vid(n),title:'Size '+n,sku:'SKU'+n,
    locations:[{location_id:lid(1),location_name:'Online Ready to Ship',available:3},{location_id:lid(2),location_name:'Workshop',available:20}]}))}]};
const sales=[
  {kind:'coverage',day:'2026-10-19',channel:'Online Store',eligible_orders:2,orders_with_lines:2,unattributed_lines:0,invalid_quantity_lines:0,outside_selection_lines:1},
  {kind:'sales',day:'2026-10-19',channel:'Online Store',variant_id:vid(1),units:4}
];
const settings={sellableLocationIds:[lid(1)],verifiedWindows:[{start:'2026-10-19',end:'2026-11-09',channels:['Online Store','POS']}]};
test('TW short, explicit-month and failed long-form requests reach durable delivery',async t=>{
  const exportStore=createMemoryExportStore(), stages=[], calls=[];
  const twSupplierReport=createTwSupplierReportService({artifactStore:exportStore,settings,readInventory:async()=>inventory,
    readSales:async args=>{calls.push(args);return sales;}});
  const baseline=createOracleBaselineDispatcher({twSupplierReport:(m,o)=>{stages.push(o.analysisContext.tool_route);return twSupplierReport(m,o);},
    generalAnalytics:()=>assert.fail('general-sales fallback'),historicalEventComparison:()=>assert.fail('campaign fallback')});
  const h=await acceptanceServer({baseline,exportStore,generateProposals:async()=>assert.fail('knowledge proposals')},{durable:true,now});
  t.after(h.close);
  for(const prompt of ['TW supplier stock report','TW supplier stock report for October 2026',long]){
    assert.equal(oracleRequestRoute(prompt,{hasCompletedJob:true}),'job');
    const r=await h.submit(prompt);
    assert.equal(r.analysis_context.tool_route,'get_tw_supplier_stock_report');
    assert.equal(r.evidence.recommended_count,0);
    assert.deepEqual(r.proposals,[]);
    const url=h.origin+r.artifact.download_url;
    assert.equal((await fetch(url)).status,401);
    const download=await fetch(url,{headers:h.headers});
    assert.equal(download.status,200);
    const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await download.arrayBuffer()));
    assert.equal(wb.getWorksheet('Order recommendations').rowCount,3);
    assert.equal(wb.getWorksheet('Monthly sales').rowCount,33);
  }
  assert.deepEqual(stages,Array(3).fill('get_tw_supplier_stock_report'));
  assert.equal(calls[0].endExclusive,'2026-11-10');
  assert.deepEqual(calls[0].variantIds,[vid(1),vid(2)]);
});
test('partial October preserves observed units, does not fabricate zeros or recommendations',()=>{
  const report=buildTwWorkbookRows({context,today:'2026-11-10',inventory,sales,settings});
  const oct=report.tabs['Monthly sales'].filter(r=>r.period==='2026-10');
  assert.equal(oct[0].online_units,4);
  assert.equal(oct[1].online_units,null);
  assert.equal(report.recommended,0);
  assert.equal(report.tabs['Stock by location'][0].usable_available,3);
  assert.equal(report.tabs['Stock by location'][0].combined_available,23);
  const unavailable=buildTwWorkbookRows({context,today:'2026-11-10',inventory,sales:null,settings});
  assert.equal(unavailable.tabs['Stock by location'][0].usable_available,3);
  assert.equal(unavailable.tabs['Monthly sales'][0].observed_total_units,null);
  assert.match(twSalesSql('fixture'),/variant_id IN UNNEST\(JSON_VALUE_ARRAY\(@variants\)\)/);
});
test('verified demand adds only incremental units for an upcoming participating event',()=>{
  const historicalSales=[...sales,
    {kind:'sales',day:'2026-08-03',channel:'Online Store',variant_id:vid(1),units:10},
    {kind:'sales',day:'2026-09-03',channel:'Online Store',variant_id:vid(1),units:10},
    {kind:'sales',day:'2026-10-03',channel:'Online Store',variant_id:vid(1),units:6},
    {kind:'sales',day:'2026-11-05',channel:'Online Store',variant_id:vid(1),units:20}];
  const base={sellableLocationIds:[lid(1)],verifiedWindows:[{start:'2026-08-01',end:'2026-11-09',channels:['Online Store','POS']}]};
  const make=parts=>buildTwWorkbookRows({context,today:'2026-11-10',inventory,sales:historicalSales,settings:{...base,...parts}}).tabs['Order recommendations'][0];
  assert.equal(make({}).suggested_units,27);
  const upcoming={name:'Black Friday',start:'2027-11-05',end:'2027-11-09'};
  const inputs={leadDays:320,participates:['Black Friday'],packSize:6};
  const boosted=make({futureEvents:[upcoming],variants:{[vid(1)]:inputs}});
  const ordinary=make({futureEvents:[upcoming],variants:{[vid(1)]:{...inputs,participates:[]}}});
  assert.ok(boosted.incremental_event_units>0);
  assert.ok(boosted.suggested_units>ordinary.suggested_units);
  assert.equal(boosted.suggested_units%6,0);
});
test('known social sales and confirmed non-TW exceptions do not block TW demand',()=>{
  const base={sellableLocationIds:[lid(1)],verifiedWindows:[{start:'2026-08-01',end:'2026-11-01',channels:['Online Store','POS']}]};
  const rows=[
    {kind:'coverage',day:'2026-10-19',channel:'POS',eligible_orders:1,orders_with_lines:1,unattributed_lines:0,non_tw_lines_without_variant:1},
    {kind:'sales',day:'2026-10-19',channel:'Online Store',variant_id:vid(1),units:4},
    {kind:'sales',day:'2026-10-19',channel:'Facebook & Instagram',variant_id:vid(1),units:2}
  ];
  const build=sales=>buildTwWorkbookRows({context,today:'2026-11-10',inventory,sales,settings:base});
  const report=build(rows),oct=report.tabs['Monthly sales'].find(r=>r.period==='2026-10'&&r.variant_id===vid(1));
  assert.equal(oct.facebook_instagram_observed_units,2);
  assert.equal(oct.observed_total_units,4);
  assert.equal(report.recommended,2);
  assert.equal(report.coverage.find(r=>r.period==='2026-10'&&r.channel==='POS').confirmed_non_tw_lines_without_variant,1);
  assert.equal(build([{...rows[0],unattributed_lines:1,tw_lines_without_variant:1},...rows.slice(1)]).recommended,0);
  assert.match(twSalesSql('fixture'),/WHEN 'facebook & instagram' THEN 'Facebook & Instagram'/);
  assert.match(twSalesSql('fixture'),/variant_id IS NULL AND NOT confirmed_non_tw_product/);
});

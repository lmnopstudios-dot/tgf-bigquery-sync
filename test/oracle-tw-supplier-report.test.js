import {twPlanningDates,twBuyPlan,twMayDeadline} from '../oracle/tw-supplier-planning.js';
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
const context={start_date:'2025-11-01',end_date:'2026-11-10'};
const inventory={as_of:'2026-11-10T12:01:00Z',population:{catalogue_complete:true,locations_complete:true},locations:[{id:lid(1)},{id:lid(2)}],failures:[],
  products:[{title:'Fixture ring',variants:[1,2].map(n=>({id:vid(n),title:'Size '+n,sku:'SKU'+n,
    locations:[{location_id:lid(1),location_name:'Online Ready to Ship',available:3},{location_id:lid(2),location_name:'Workshop',available:20}]}))}]};
const sales=[
  {kind:'coverage',day:'2026-10-19',channel:'Online Store',eligible_orders:2,orders_with_lines:2,unattributed_lines:0,invalid_quantity_lines:0,outside_selection_lines:1},
  {kind:'sales',day:'2026-10-19',channel:'Online Store',variant_id:vid(1),units:4}
];
const settings={sellableLocationIds:[lid(1)],verifiedWindows:[{start:'2026-10-19',end:'2026-11-09',channels:['Online Store','POS']}]};
test('TW short, explicit-month and failed long-form requests reach durable delivery',async t=>{
  const exportStore=createMemoryExportStore(), stages=[], calls=[], inventoryCalls=[];
  const twSupplierReport=createTwSupplierReportService({artifactStore:exportStore,settings,readInventory:async args=>{inventoryCalls.push(args);return inventory;},
    readSales:async args=>{calls.push(args);return sales;}});
  const baseline=createOracleBaselineDispatcher({twSupplierReport:(m,o)=>{stages.push(o.analysisContext.tool_route);return twSupplierReport(m,o);},
    generalAnalytics:()=>assert.fail('general-sales fallback'),historicalEventComparison:()=>assert.fail('campaign fallback')});
  const h=await acceptanceServer({baseline,exportStore,generateProposals:async()=>assert.fail('knowledge proposals')},{durable:true,now});
  t.after(h.close);
  for(const prompt of ['TW supplier stock report','TW supplier stock report as of 10 November 2026','TW supplier stock report for October 2026',long]){
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
    assert.equal(wb.worksheets[0].name,'Read me');
    assert.ok(wb.getWorksheet('Trial buy'));
    const historical=prompt.includes('for October');
    const buy=wb.getWorksheet('Order recommendations');
    const buyHeaders=buy.getRow(1).values;
    assert.equal(buy.getRow(2).getCell(buyHeaders.indexOf('Supplier buy · Cover months')).value,1);
    assert.equal(buy.getRow(2).getCell(buyHeaders.indexOf('Supplier buy · Ordinary cover through')).value,historical?'2027-02-27':'2027-03-09');
    assert.equal(r.analysis_context.end_date,historical?'2026-10-31':'2026-11-10');
    const stock=wb.getWorksheet('Stock by location');
    const headers=stock.getRow(1).values;
    assert.equal(stock.getRow(2).getCell(headers.indexOf('usable_available')).value,historical?null:3);
    assert.equal(r.evidence.as_of,historical?null:inventory.as_of);
  }
  assert.deepEqual(stages,Array(4).fill('get_tw_supplier_stock_report'));
  assert.equal(calls[0].endExclusive,'2026-11-11');
  assert.equal(calls[2].endExclusive,'2026-11-01');
  assert.equal(inventoryCalls[2].catalogueOnly,true);
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
test('May uplift is a separate top-up and does not change the ordinary buy',()=>{
  const historicalSales=[...sales,
    {kind:'sales',day:'2026-05-01',channel:'Online Store',variant_id:vid(1),units:20},
    {kind:'sales',day:'2026-08-03',channel:'Online Store',variant_id:vid(1),units:10}];
  const base={sellableLocationIds:[lid(1)],verifiedWindows:[{start:'2026-05-01',end:'2026-11-09',channels:['Online Store','POS']}]};
  const make=parts=>buildTwWorkbookRows({context,today:'2026-11-10',inventory,sales:historicalSales,settings:{...base,...parts}}).tabs;
  const noMay=make({}), withMay=make({futureEvents:[{name:'May Bank Holiday',start:'2027-05-01',end:'2027-05-05'}],
    mayPlan:{requiredShelfDate:'2027-04-30',receivingBufferDays:7},
    variants:{[vid(1)]:{participates:['May Bank Holiday']}}});
  assert.equal(noMay['Order recommendations'][0].suggested_units,withMay['Order recommendations'][0].suggested_units);
  assert.ok(withMay['May top-up'][0].provisional_incremental_units>0);
  assert.equal(withMay['May top-up'][0].order_by,'2027-01-23');
  assert.equal(noMay['May top-up'][0].order_by,null);
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
  assert.equal(report.recommended,1);
  assert.equal(report.coverage.find(r=>r.period==='2026-10'&&r.channel==='POS').confirmed_non_tw_lines_without_variant,1);
  assert.equal(build([{...rows[0],unattributed_lines:1,tw_lines_without_variant:1},...rows.slice(1)]).recommended,1);
  assert.match(twSalesSql('fixture'),/WHEN 'facebook & instagram' THEN 'Facebook & Instagram'/);
  assert.match(twSalesSql('fixture'),/variant_id IS NULL AND NOT confirmed_non_tw_product/);
});
test('today includes post-sale activity without baking the past sale into ordinary demand',()=>{
  const completeSettings={verifiedWindows:[{start:'2026-08-01',end:'2026-11-09',channels:['Online Store','POS']}]};
  const locationNames=['Kings Cross','Shoreditch','Soho','Online Ready to Ship','Shoreditch Workshop'];
  const stocked={...inventory,locations:locationNames.map((name,i)=>({id:lid(i+1),name})),
    products:[{...inventory.products[0],variants:inventory.products[0].variants.map(v=>({...v,
      locations:locationNames.map((location_name,i)=>({location_id:lid(i+1),location_name,
        available:i===4?100:0,committed:10}))}))}]};
  const data=[
    ...sales,
    {kind:'coverage',day:'2026-10-20',channel:'POS',eligible_orders:2,orders_with_lines:2,unattributed_lines:1},
    {kind:'sales',day:'2026-11-05',channel:'Online Store',variant_id:vid(2),units:70},
    {kind:'sales',day:'2026-10-21',channel:'Online Store',variant_id:vid(2),units:10},
    {kind:'sales',day:'2026-11-10',channel:'Online Store',variant_id:vid(2),units:2}
  ];
  const run=sales=>buildTwWorkbookRows({context,today:'2026-11-10',inventory:stocked,sales,settings:completeSettings});
  const report=run(data),top=report.tabs['Order recommendations'][0];
  assert.equal(top.variant_id,vid(2));
  assert.equal(top.black_friday_observed_units,70);
  assert.equal(top.post_sale_observed_units,2);
  assert.equal(top.ordinary_observed_units_excluding_post_sale,10);
  assert.equal(top.usable_stock,0);
  assert.equal(top['Before delivery · Expected arrival'],'2027-02-10');
  assert.equal(top.suggested_units,run(data.filter(r=>r.day!=='2026-11-05'&&r.day!=='2026-11-10')).tabs['Order recommendations'].find(r=>r.variant_id===vid(2)).suggested_units);
  assert.ok(top.suggested_units>0);
  assert.equal(report.latestCovered,'2026-11-08');
  assert.equal(report.coverageGapDays,1);
  assert.equal(report.tabs['Stock by location'].find(r=>r.variant_id===vid(2)).workshop_available,100);
  assert.equal(report.tabs['Monthly sales'].find(r=>r.period==='2026-11 MTD').partial_current_day,true);
});

test('only a verified stock snapshot on the historical cutoff may support an order quantity',()=>{
  const historyContext={...context,end_date:'2026-10-31'};
  const args={context:historyContext,today:'2026-11-10',inventory,sales,
    settings:{sellableLocationIds:[lid(1)],verifiedWindows:[{start:'2026-08-01',end:'2026-11-01',channels:['Online Store','POS']}]}};
  const get=snapshot=>buildTwWorkbookRows({...args,snapshot}).tabs['Order recommendations'][0];
  assert.equal(get().usable_stock,null);
  assert.equal(get({verified:true,date:'2026-10-31',inventory}).suggested_units,null);
  assert.equal(get({verified:false,date:'2026-10-31',inventory:{...inventory,as_of:'2026-10-31T21:00:00Z'}}).suggested_units,null);
  assert.equal(get({verified:true,date:'2026-10-31',inventory:{...inventory,as_of:'2026-10-31T21:00:00Z'}}).usable_stock,3);
});

test('London cutoff uses local midnight and rejects future or impossible dates',async()=>{
  const {twSupplierScope}=await import('../public/oracle/tw-supplier-intent.js');
  const summer=Date.parse('2026-07-31T23:30:00Z');
  assert.equal(twSupplierScope('TW supplier stock report',summer).end_date,'2026-08-01');
  assert.equal(twSupplierScope('TW supplier stock report as of 31 July 2026',summer).start_date,'2025-08-01');
  assert.equal(twSupplierScope('TW supplier stock report as of 31 June 2026',summer).invalid,true);
  assert.equal(twSupplierScope('TW supplier stock report as of 2026-08-02',summer).invalid,true);
});

test('historical catalogue-only read never asks Shopify for live inventory levels',async()=>{
  const {readInventoryReport}=await import('../oracle/inventory-report.js');
  const conn=nodes=>({nodes,pageInfo:{hasNextPage:false}});
  const calls=[];
  const result=await readInventoryReport({requiredExactTag:'tw',catalogueOnly:true,getToken:async()=>'fixture',
    graphql:async(_token,q)=>{
      calls.push(q.match(/query (\w+)/)?.[1]);
      if(q.includes('InventoryCatalogue'))return {products:conn([{id:'gid://shopify/Product/1',title:'TW ring',tags:['TW'],status:'ACTIVE'}])};
      if(q.includes('InventoryReportVariants'))return {product:{variants:conn([{id:vid(1),inventoryItem:{id:'fixture',tracked:true}}])}};
      assert.fail('Historical catalogue queried live inventory');
    }});
  assert.deepEqual(calls,['InventoryCatalogue','InventoryReportVariants']);
  assert.deepEqual(result.products[0].variants[0].locations,[]);
});


test('three calendar months fixes arrival, and shortages do not become backorders',()=>{
  assert.deepEqual(twPlanningDates('2026-11-10'),{arrival:'2027-02-10',coverEnd:'2027-03-10',coverThrough:'2027-03-09'});
  assert.equal(twPlanningDates('2026-11-30').arrival,'2027-02-28');
  assert.equal(twMayDeadline('2027-02-28',0),'2026-11-30');
  const args={cutoff:'2026-11-10',dailyDemand:1,usable:2};
  const plan=twBuyPlan(args);
  assert.equal(plan.short,90);
  assert.equal(plan.remaining,0);
  assert.equal(plan.suggested,28);
  const dated=twBuyPlan({...args,inputs:{inboundReviewedOn:args.cutoff,
    confirmedInbound:[{dueDate:'2027-02-08',units:10},{dueDate:'2027-02-10',units:5},{dueDate:'2027-03-10',units:30}],
    backordersReviewedOn:args.cutoff,confirmedBackordersNotInAvailable:4}});
  assert.equal(dated.short,88);
  assert.equal(dated.remaining,8);
  assert.equal(dated.inboundAfter,5);
  const boundary=(dueDate)=>twBuyPlan({...args,inputs:{inboundReviewedOn:args.cutoff,confirmedInbound:[{dueDate,units:3}]}});
  assert.equal(boundary('2027-03-09').suggested,25);
  assert.equal(boundary('2027-03-10').suggested,28);
  assert.equal(dated.suggested,19);
  assert.equal(twBuyPlan({...args,inputs:{leadDays:0,confirmedBackordersNotInAvailable:100}}).suggested,28);
  assert.equal(twBuyPlan({...args,usable:null}).suggested,null);
});

test('trial buy separates low-stock candidates from ordinary buys and excludes sale spikes from the depletion pace',()=>{
  const v=(n,available)=>({...inventory.products[0].variants[0],id:vid(n),
    locations:[{location_id:lid(1),location_name:'Online Ready to Ship',available},{location_id:lid(2),location_name:'Workshop',available:20}]});
  const catalogue={...inventory,products:[{...inventory.products[0],variants:[v(1,0),v(2,4),v(3,1),v(4,0),v(5,null)]}]};
  const row=(id,units,day)=>({kind:'sales',day,channel:'Online Store',variant_id:vid(id),units});
  const data=[row(1,8,'2026-11-05'),row(2,20,'2026-11-05'),row(3,6,'2026-06-01'),row(5,12,'2026-11-06'),row(4,10,'2026-11-10')];
  const report=buildTwWorkbookRows({context,today:'2026-11-10',inventory:catalogue,sales:data,settings});
  assert.equal(report.recommended,0);
  assert.equal(report.trialCount,2);
  assert.deepEqual(report.tabs['Trial buy'].map(r=>[r.variant_id,r.reason,r.trial_units_for_review]),
    [[vid(1),'Out of stock',3],[vid(3),'Likely to run out before delivery',3]]);
  const alreadyInbound=buildTwWorkbookRows({context,today:'2026-11-10',inventory:catalogue,sales:data,settings:{...settings,
    variants:{[vid(1)]:{inboundReviewedOn:'2026-11-10',confirmedInbound:[{dueDate:'2027-02-10',units:3}]}}}});
  assert.equal(alreadyInbound.trialCount,1);
  assert.ok(report.tabs['Read me'].some(r=>r.section==='Trial buy'));
});

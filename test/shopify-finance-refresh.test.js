import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchUpdatedOrders, parseArgs, preflight, preflightStatements, promotionSql, transform } from '../shopify/finance-refresh.js';

const order=(id,updatedAt,refunds=[])=>({id,name:`#${id}`,createdAt:'2026-01-01T00:00:00Z',updatedAt,app:{id:'native',name:'Online Store'},retailLocation:{id:'loc',name:'London'},totalPriceSet:{shopMoney:{amount:'12',currencyCode:'GBP'},presentmentMoney:{amount:'15',currencyCode:'USD'}},transactions:[{id:'tx-1'}],refunds});
const refund={id:'refund-old-order',createdAt:'2026-09-26T12:00:00Z',totalRefundedSet:{shopMoney:{amount:'2',currencyCode:'GBP'},presentmentMoney:{amount:'2.5',currencyCode:'USD'}},refundLineItems:{nodes:[]},refundShippingLines:{nodes:[]},orderAdjustments:{nodes:[]},transactions:{nodes:[{id:'refund-tx',kind:'REFUND',status:'SUCCESS',amountSet:{shopMoney:{amount:'2'},presentmentMoney:{amount:'2.5'}}}]}};

test('bounded pagination includes an older order updated by a new refund',async()=>{
  const calls=[];const graphql=async(_q,v)=>{calls.push(v);return {orders:calls.length===1?{nodes:[order('old','2026-09-26T13:00:00Z',[refund])],pageInfo:{hasNextPage:true,endCursor:'next'}}:{nodes:[order('new','2026-09-29T00:00:00Z')],pageInfo:{hasNextPage:false,endCursor:null}}}};
  const result=await fetchUpdatedOrders({graphql,start:'2026-09-25T00:00:00.000Z',end:'2026-10-01T00:00:00.000Z'});
  assert.equal(result.pages,2);assert.equal(result.orders[0].createdAt,'2026-01-01T00:00:00Z');assert.match(calls[0].query,/updated_at:>='2026-09-25/);assert.equal(transform(result.orders).refunds[0].refund_id,'refund-old-order');
});

test('incomplete pagination fails rather than promoting a partial result',async()=>{
  await assert.rejects(()=>fetchUpdatedOrders({graphql:async()=>({orders:{nodes:[order('1','2026-09-26T00:00:00Z')],pageInfo:{hasNextPage:true,endCursor:'again'}}}),start:'2026-09-25T00:00:00.000Z',end:'2026-10-01T00:00:00.000Z',maxPages:1}),/incomplete/);
});

test('promotion is atomic, idempotently replaces selected identities, and never truncates history',()=>{
  const sql=promotionSql('p','d',{orders:'so',financials:'sf',refunds:'sr'});
  assert.match(sql,/BEGIN TRANSACTION/);assert.match(sql,/DELETE FROM `p\.d\.order_financials` WHERE order_id IN/);assert.match(sql,/successful_watermark/);assert.doesNotMatch(sql,/TRUNCATE/i);assert.doesNotMatch(sql,/DELETE FROM `p\.d\.order_financials`\s*;/);
});

test('explicit incident window is half-open and scheduled mode needs no dates',()=>{
  const explicit=parseArgs(['--mode','collect','--start','2026-09-25T00:00:00Z','--end','2026-10-01T00:00:00Z']);assert.equal(explicit.end,'2026-10-01T00:00:00.000Z');
  assert.equal(parseArgs(['--mode','scheduled']).mode,'scheduled');
});

test('preflight keeps only finance dependency inspection in SQL',()=>{
  const statements=preflightStatements('gf-full-data');
  assert.equal(statements.destination_tables,undefined);
  assert.match(statements.finance_dependencies,/FROM `gf-full-data`\.finance\.INFORMATION_SCHEMA\.TABLES/);
  assert.doesNotMatch(statements.finance_dependencies,/TABLE_STORAGE/);
  assert.doesNotMatch(statements.finance_dependencies,/`gf-full-data\.finance\.INFORMATION_SCHEMA/);
});

const schemas={
  order_locations:'order_id:STRING:REQUIRED order_name:STRING created_at:TIMESTAMP updated_at:TIMESTAMP order_source:STRING source_app_id:STRING retail_location_id:STRING retail_location_name:STRING synced_at:TIMESTAMP',
  order_financials:'order_id:STRING:REQUIRED order_name:STRING created_at:TIMESTAMP processed_at:TIMESTAMP updated_at:TIMESTAMP cancelled_at:TIMESTAMP order_source:STRING shop_currency:STRING presentment_currency:STRING original_total_shop:NUMERIC original_total_presentment:NUMERIC original_subtotal_shop:NUMERIC original_subtotal_presentment:NUMERIC original_tax_shop:NUMERIC original_tax_presentment:NUMERIC original_discounts_shop:NUMERIC original_discounts_presentment:NUMERIC original_shipping_shop:NUMERIC original_shipping_presentment:NUMERIC total_refunded_shop:NUMERIC total_refunded_presentment:NUMERIC total_received_shop:NUMERIC total_received_presentment:NUMERIC payment_gateway_names_json:STRING transactions_json:STRING synced_at:TIMESTAMP',
  order_refunds:'refund_id:STRING:REQUIRED order_id:STRING:REQUIRED order_name:STRING refund_created_at:TIMESTAMP refund_processed_at:TIMESTAMP refund_updated_at:TIMESTAMP shop_currency:STRING presentment_currency:STRING refund_total_shop:NUMERIC refund_total_presentment:NUMERIC refund_line_subtotal_shop:NUMERIC refund_line_subtotal_presentment:NUMERIC refund_shipping_subtotal_shop:NUMERIC refund_shipping_subtotal_presentment:NUMERIC refund_line_tax_shop:NUMERIC refund_line_tax_presentment:NUMERIC refund_shipping_tax_shop:NUMERIC refund_shipping_tax_presentment:NUMERIC refund_adjustment_tax_shop:NUMERIC refund_adjustment_tax_presentment:NUMERIC refund_tax_shop:NUMERIC refund_tax_presentment:NUMERIC successful_transaction_shop:NUMERIC successful_transaction_presentment:NUMERIC has_successful_refund_transaction:BOOL note:STRING refund_line_items_json:STRING refund_shipping_lines_json:STRING order_adjustments_json:STRING transactions_json:STRING synced_at:TIMESTAMP'
};
const schema=name=>schemas[name].split(' ').map(value=>{const [fieldName,type,mode]=value.split(':');return {name:fieldName,type,...(mode?{mode}:{})}});

test('preflight uses named table metadata and dry-runs only the exact finance SQL',async()=>{
  const jobs=[],queries=[],locations={shopify_data:'US',finance:'EU'};
  const bigquery={
    dataset:(name,options)=>({getMetadata:async()=>[{location:locations[name]}],table:tableName=>({getMetadata:async()=>[{type:'TABLE',location:'US',schema:{fields:schema(tableName)},...(tableName==='order_locations'?{numRows:'0'}:{})}]})}),
    createQueryJob:async options=>{jobs.push(options);return[{}]},
    query:async options=>{queries.push(options);return [[{table_name:'example'}]]}
  };
  const result=await preflight({bigquery,project:'gf-full-data'});
  assert.deepEqual(result.dataset_locations,{shopify_data:'US',finance:'EU'});
  assert.equal(result.read_only,true);assert.equal(result.dry_run,true);
  assert.equal(jobs.length,1);assert.equal(queries.length,1);
  assert.deepEqual(jobs.map(x=>[x.query,x.location,x.dryRun]),queries.map(x=>[x.query,x.location,true]));
  assert.ok([...jobs,...queries].every(x=>/^SELECT\b/.test(x.query)));
  assert.equal(jobs[0].location,'EU');assert.doesNotMatch(jobs[0].query,/TABLE_STORAGE/);
  assert.equal(result.destination_tables[0].row_count_metadata.value,'0');
  assert.equal(result.destination_tables[0].row_count_metadata.available,true);
  assert.equal(result.destination_tables[1].row_count_metadata.value,null);
  assert.equal(result.destination_tables[1].row_count_metadata.available,false);
  assert.ok(result.destination_tables.every(table=>table.write_ready&&table.row_count_metadata.exact_reconciliation_evidence===false));
});

test('preflight succeeds where TABLE_STORAGE is unavailable because it is never queried',async()=>{
  const seen=[];
  const bigquery={
    dataset:name=>({getMetadata:async()=>[{location:name==='finance'?'EU':'US'}],table:tableName=>({getMetadata:async()=>[{type:'TABLE',schema:{fields:schema(tableName)},numRows:'12'}]})}),
    createQueryJob:async options=>{seen.push(options.query);if(options.query.includes('TABLE_STORAGE'))throw new Error('TABLE_STORAGE unavailable');return[{}]},
    query:async()=>[[]]
  };
  const result=await preflight({bigquery,project:'gf-full-data'});
  assert.equal(result.destination_tables.length,3);assert.ok(seen.every(sql=>!sql.includes('TABLE_STORAGE')));
});

test('preflight retains bounded stage-specific destination write-readiness failures',async()=>{
  const bigquery={dataset:name=>({getMetadata:async()=>[{location:name==='finance'?'EU':'US'}],table:tableName=>({getMetadata:async()=>[{type:'TABLE',schema:{fields:schema(tableName)},streamingBuffer:{estimatedRows:'1'}}]})})};
  await assert.rejects(preflight({bigquery,project:'gf-full-data'}),error=>{
    assert.equal(error.stage,'preflight:write_readiness:destination_tables:order_locations');
    assert.equal(error.code,'DESTINATION_NOT_WRITE_READY');assert.match(error.message,/active streaming buffer/);assert.ok(error.message.length<400);return true;
  });
});

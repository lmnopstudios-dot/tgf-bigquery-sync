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

test('preflight generates the special INFORMATION_SCHEMA qualification instead of a quoted four-part table path',()=>{
  const statements=preflightStatements('gf-full-data','shopify_data');
  assert.match(statements.destination_tables,/FROM `gf-full-data`\.shopify_data\.INFORMATION_SCHEMA\.TABLE_STORAGE/);
  assert.match(statements.finance_dependencies,/FROM `gf-full-data`\.finance\.INFORMATION_SCHEMA\.TABLES/);
  assert.doesNotMatch(statements.destination_tables,/`gf-full-data\.shopify_data\.INFORMATION_SCHEMA/);
  assert.doesNotMatch(statements.finance_dependencies,/`gf-full-data\.finance\.INFORMATION_SCHEMA/);
});

test('preflight resolves both dataset locations and dry-runs the exact generated SQL before read-only execution',async()=>{
  const jobs=[],queries=[],locations={shopify_data:'US',finance:'EU'};
  const bigquery={
    dataset:name=>({getMetadata:async()=>[{location:locations[name]}]}),
    createQueryJob:async options=>{jobs.push(options);return[{}]},
    query:async options=>{queries.push(options);return [[{table_name:'example'}]]}
  };
  const result=await preflight({bigquery,project:'gf-full-data'});
  assert.deepEqual(result.dataset_locations,{shopify_data:'US',finance:'EU'});
  assert.equal(result.read_only,true);assert.equal(result.dry_run,true);
  assert.deepEqual(jobs.map(x=>[x.query,x.location,x.dryRun]),queries.map(x=>[x.query,x.location,true]));
  assert.ok([...jobs,...queries].every(x=>/^SELECT\b/.test(x.query)));
});

test('preflight reports a bounded stage and corrected statement when a live dry-run fails',async()=>{
  const bigquery={
    dataset:name=>({getMetadata:async()=>[{location:name==='finance'?'EU':'US'}]}),
    createQueryJob:async options=>{if(options.query.includes('TABLE_STORAGE'))throw Object.assign(new Error('raw'),{code:404,errors:[{reason:'notFound',message:'Not found: Dataset gf-full-data:shopify_data.INFORMATION_SCHEMA credential=abc',location:'US'}]});return[{}]},
    query:async()=>[[]]
  };
  await assert.rejects(preflight({bigquery,project:'gf-full-data'}),error=>{
    assert.equal(error.stage,'preflight:dry_run:destination_tables');assert.equal(error.reason,'notFound');assert.equal(error.code,404);
    assert.match(error.statement,/`gf-full-data`\.shopify_data\.INFORMATION_SCHEMA\.TABLE_STORAGE/);
    assert.doesNotMatch(error.message,/credential=abc/);assert.ok(error.message.length<400);return true;
  });
});

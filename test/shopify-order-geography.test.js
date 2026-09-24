import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, diagnosticQueries } from '../diagnostics/shopify-shipping-geography.js';
import { fetchShippingGeography, GEOGRAPHY_QUERY, normalizeShippingGeography, persistShippingGeography } from '../shopify/order-geography.js';

const base = { id:'gid://shopify/Order/1', name:'#1', createdAt:'2025-09-21T00:00:00Z', updatedAt:'2025-09-22T00:00:00Z', app:{id:'native'} };

test('normalizes direct Shopify Online shipping country without retaining address PII', () => {
  const row=normalizeShippingGeography({...base,shippingAddress:{countryCodeV2:'de',country:'Germany',city:'Secret',zip:'X',name:'Person'}});
  assert.equal(row.shipping_country_code,'DE'); assert.equal(row.shipping_country_code_source,'de'); assert.equal(row.shipping_country_name,'Germany'); assert.equal(row.geography_status,'valid');
  assert.equal(row.retail_location_id,null); assert.doesNotMatch(JSON.stringify(row),/Secret|Person/);
});

test('POS/pickup without an address is explicit missing evidence',()=>{
  const row=normalizeShippingGeography({...base,retailLocation:{id:'gid://shopify/Location/2'},shippingAddress:null});
  assert.equal(row.geography_status,'missing_address'); assert.equal(row.shipping_country_code,null);
});

test('blank and invalid direct codes are distinguished',()=>{
  assert.equal(normalizeShippingGeography({...base,shippingAddress:{countryCodeV2:' '}}).geography_status,'missing_code');
  const invalid=normalizeShippingGeography({...base,shippingAddress:{countryCodeV2:'XX',country:'Invalid'}});
  assert.equal(invalid.geography_status,'invalid_code'); assert.equal(invalid.shipping_country_code,null); assert.equal(invalid.shipping_country_code_source,'XX');
});

test('historical and incremental fetches paginate, filter Matrixify, and request address updates',async()=>{
  const calls=[]; const graphql=async(_q,v)=>{calls.push(v);return {orders:{nodes:v.cursor?[]:[{...base,shippingAddress:{countryCodeV2:'GB'}},{...base,id:'m',app:{id:'gid://shopify/App/1758145'}}],pageInfo:v.cursor?{hasNextPage:false}:{hasNextPage:true,endCursor:'next'}}}};
  const rows=await fetchShippingGeography({graphql,updatedSince:'2025-09-20T00:00:00.000Z'});
  assert.equal(rows.length,1); assert.match(calls[0].query,/updated_at:>=/); assert.match(GEOGRAPHY_QUERY,/sortKey: UPDATED_AT/); assert.match(GEOGRAPHY_QUERY,/shippingAddress \{ countryCodeV2 country \}/);
});

test('persistence backfill and updates merge once by stable order ID',async()=>{
  const queries=[]; const deleted=[]; const table={insert:async()=>{},delete:async()=>deleted.push(true)}; const bq={query:async x=>{queries.push(x.query);return [[]]},dataset:()=>({createTable:async()=>{},table:()=>table})};
  await persistShippingGeography({bigquery:bq,project:'p',rows:[normalizeShippingGeography({...base,shippingAddress:{countryCodeV2:'FR'}})],mode:'backfill'});
  assert.match(queries.at(-1),/TRUNCATE TABLE/); assert.match(queries.at(-1),/MERGE/); assert.match(queries.at(-1),/T\.order_id=S\.order_id/); assert.equal(deleted.length,1);
});

test('aggregate diagnostic is read-only, date-aware, channelled and validates sales/cardinality',()=>{
  const queries=diagnosticQueries('p'); const sql=Object.values(queries).join('\n');
  assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i);
  assert.match(queries.coverage,/DATE '2020-02-01'/); assert.match(queries.coverage,/eligible_eu_samples/); assert.match(queries.coverage,/missing_address/); assert.match(queries.coverage,/invalid_code/); assert.match(queries.coverage,/retail_location_id IS NULL/);
  assert.match(queries.parent_sales,/expected_sales/); assert.match(queries.integrity,/MAX\(g\.synced_at\)/);
  assert.match(queries.destination_metadata,/INFORMATION_SCHEMA\.TABLES/);
  assert.match(queries.direct_field_evidence,/INFORMATION_SCHEMA\.COLUMNS/);
  assert.match(queries.source_scope,/matrixify_excluded_orders/);
});

test('diagnostic emits valid BigQuery named STRUCT fields in every generated query',()=>{
  const queries=diagnosticQueries('p');
  assert.deepEqual(Object.keys(queries),['destination_metadata','direct_field_evidence','source_scope','coverage','integrity','parent_sales']);
  for (const [stage,sql] of Object.entries(queries)) {
    assert.doesNotMatch(sql,/STRUCT\([^)]*(?:'[^']*'|DATE '[^']*'|\))\s+(?:code|joined|left_on)\b/,
      `${stage} contains a STRUCT field alias without AS`);
  }
  assert.match(queries.coverage,/STRUCT\('AT' AS code,DATE '1995-01-01' AS joined,CAST\(NULL AS DATE\) AS left_on\)/);
});

test('diagnostic query errors identify the bounded failing stage',async()=>{
  const bigquery={query:async()=>{throw new Error(`Expected ")" or ","${'x'.repeat(400)}\nunsafe detail`)}};
  await assert.rejects(diagnose({bigquery,project:'p'}),error=>{
    assert.match(error.message,/^Shopify shipping geography diagnostic failed during destination_metadata: Expected "\)" or ","/);
    assert.ok(error.message.length <= 365); assert.doesNotMatch(error.message,/unsafe detail/);
    return true;
  });
});

test('missing destination produces a valid PII-free pre-backfill report without querying it',async()=>{
  const calls=[];
  const bigquery={query:async options=>{
    calls.push(options);
    if(options.query.includes('INFORMATION_SCHEMA.TABLES')) return [[{destination_table_count:0}]];
    if(options.query.includes('INFORMATION_SCHEMA.COLUMNS')) return [[{table_name:'legacy_orders',column_name:'shipping_country',data_type:'STRING'}]];
    return [[{source_shopify_orders:12,matrixify_excluded_orders:2,expected_write_orders:10,expected_online_orders:8,expected_pos_orders:2}]];
  }};
  const report=await diagnose({bigquery,project:'p'});
  assert.equal(report.valid,true); assert.equal(report.phase,'pre_backfill'); assert.equal(report.destination_present,false);
  assert.equal(report.evidence.source_scope[0].expected_write_orders,10);
  assert.deepEqual(report.evidence.coverage,{status:'not_yet_measurable',reason:'destination_table_absent'});
  assert.deepEqual(report.evidence.parent_sales,{status:'not_yet_measurable',reason:'destination_table_absent'});
  assert.equal(calls.length,3);
  assert.ok(calls.every(call=>!/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i.test(call.query)));
  assert.doesNotMatch(JSON.stringify(report),/(?:email|phone|postcode|recipient|address_line)/i);
});

test('present destination runs and validates the full coverage and integrity path',async()=>{
  const calls=[];
  const bigquery={query:async options=>{
    calls.push(options.query);
    if(options.query.includes('INFORMATION_SCHEMA.TABLES')) return [[{destination_table_count:1}]];
    if(options.query.includes('INFORMATION_SCHEMA.COLUMNS')) return [[]];
    if(options.query.includes('source_shopify_orders')) return [[{source_shopify_orders:10,matrixify_excluded_orders:1,expected_write_orders:9}]];
    if(options.query.includes('geography_rows')) return [[{geography_rows:9,distinct_geography_orders:9,orphan_rows:0,matrixify_rows:0}]];
    if(options.query.includes('joined_rows')) return [[{joined_rows:9,distinct_orders:9,joined_sales:100,expected_sales:100}]];
    return [[{month:'2026-01-01',channel:'Online',orders:9,valid_direct_country:8}]];
  }};
  const report=await diagnose({bigquery,project:'p'});
  assert.equal(report.valid,true); assert.equal(report.phase,'post_backfill'); assert.equal(report.destination_present,true);
  assert.ok(Array.isArray(report.evidence.coverage)); assert.equal(calls.length,6);
});

test('post-metadata stage errors remain bounded and name the safe stage',async()=>{
  let call=0;
  const bigquery={query:async()=>{call++; if(call<=3)return call===1?[[{destination_table_count:1}]]:[[]]; throw new Error('denied\nquery text with sensitive detail')}};
  await assert.rejects(diagnose({bigquery,project:'p'}),error=>{
    assert.equal(error.message,'Shopify shipping geography diagnostic failed during coverage: denied');
    assert.doesNotMatch(error.message,/sensitive/); return true;
  });
});

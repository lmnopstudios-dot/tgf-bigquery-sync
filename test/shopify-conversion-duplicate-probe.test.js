import assert from 'node:assert/strict';
import test from 'node:test';
import { runProbe } from '../diagnostics/shopify-conversion-duplicate.js';

test('September duplicate probe is bounded, paginated, read-only and emits no raw source',async()=>{
  const statements=[];
  const columns=['day','session_device_type','referrer_source','sessions','sessions_that_completed_checkout','conversion_rate','sessions_with_cart_additions','sessions_that_reached_checkout'].map(name=>({name}));
  const sourceRows=[['2026-09-03','mobile','__other__',100,2,.02,4,3],...Array.from({length:40},(_,i)=>['2026-09-03','mobile',`private-referrer-${i}`,1,0,0,0,0])];
  const report=await runProbe({timezone:'Europe/London',query:async statement=>{statements.push(statement);return{columns,rows:statement.includes('referrer_source')?sourceRows:[['2026-09-03','mobile',100,2,.02,4,3]]};}});
  assert.equal(report.read_only,true);assert.deepEqual(report.range,{start:'2026-09-03',end:'2026-09-09'});assert.equal(report.measurement_era_marker.date,'2026-09-01');assert.equal(statements.length,2);assert.ok(statements.every(statement=>statement.includes('SINCE 2026-09-03 UNTIL 2026-09-09')&&statement.includes('LIMIT 1000\nOFFSET 0')));assert.deepEqual(report.collections.map(item=>item.grouping_columns),[['day','session_device_type'],['day','session_device_type','referrer_source']]);assert.equal(report.collections[1].duplicate_identities[0].source_identity,'__other__');assert.doesNotMatch(JSON.stringify(report),/private-referrer/);
});

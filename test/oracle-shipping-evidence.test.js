import test from 'node:test';
import assert from 'node:assert/strict';
import { shippingEvidenceClass,validateShippingEvidenceInput,shippingEvidenceSql,shippingPopulationAuditSql,shippingRefundEvidenceSql,reconcileShippingPopulation,diagnoseShippingEvidence } from '../diagnostics/oracle-shipping-evidence.js';

test('missing, zero, negative and positive charges stay distinct',()=>{
  assert.equal(shippingEvidenceClass(null),'missing_stored_value');
  assert.equal(shippingEvidenceClass(undefined),'missing_stored_value');
  assert.equal(shippingEvidenceClass('0'),'ambiguous_collector_zero');
  assert.equal(shippingEvidenceClass('-8'),'invalid_stored_value');
  assert.equal(shippingEvidenceClass('invalid'),'invalid_stored_value');
  assert.equal(shippingEvidenceClass('8'),'known_positive_charge');
});
test('bounds reject invalid dates, long windows and mutating options',()=>{
  validateShippingEvidenceInput({start:'2026-09-01',end:'2026-09-30'});
  for(const input of [{start:'2026-02-30',end:'2026-03-01'},{start:'2025-01-01',end:'2026-09-30'},{start:'2026-09-30',end:'2026-09-01'},{start:'2026-09-01',end:'2026-09-30',apply:true}])assert.throws(()=>validateShippingEvidenceInput(input));
});
test('reconciliation partitions date, currency and cancellation rule differences',()=>{
  const base={oracle_date:true,reporting_date:true,oracle_rules:true,reporting_rules:true};
  const rows=[{...base,orders:100},{...base,orders:2,reporting_date:false},{...base,orders:3,oracle_date:false},{...base,orders:4,oracle_rules:false},{...base,orders:7,oracle_rules:false,reporting_rules:false}];
  const r=reconcileShippingPopulation(rows);
  assert.equal(r.oracle_orders,102);assert.equal(r.online_country_uk_gbp_orders,107);
  assert.equal(r.both,100);assert.equal(r.oracle_only,2);assert.equal(r.reporting_only,7);
  assert.equal(r.differences.length,3);
});
test('reads preserve governed eligibility and independently expose UTC reporting dates',()=>{
  const q=shippingEvidenceSql('gf-full-data');
  assert.match(q,/shipping_country_code=@country/);assert.match(q,/presentment_currency=@currency/);
  assert.match(q,/retail_location_id IS NULL/);assert.match(q,/finance_cancelled_at IS NULL/);
  assert.match(q,/original_subtotal_presentment>=250 AND original_subtotal_presentment<threshold/);
  assert.doesNotMatch(q,/NULLIF\(original_shipping_presentment,0\)/);
  const audit=shippingPopulationAuditSql('gf-full-data');
  assert.match(audit,/FULL OUTER JOIN/);assert.match(audit,/DATE\(f.created_at\) utc_finance_date/);
  assert.match(audit,/UPPER\(presentment_currency\)=@currency/);
  assert.match(audit,/LIMIT 2001/);
  for(const query of [q,audit,shippingRefundEvidenceSql('gf-full-data')])assert.doesNotMatch(query,/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|TRUNCATE)\b/i);
});
function fakeBigQuery({failAudit=false,overflow=false,refunds=false}={}){
  const calls=[];
  return {calls,dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),createQueryJob:async o=>{calls.push(o);return [{}];},query:async o=>{calls.push(o);
    if(o.query.includes('INFORMATION_SCHEMA'))return [refunds?['refund_id','order_id','synced_at','presentment_currency','refund_shipping_subtotal_presentment','refund_shipping_lines_json'].map(column_name=>({table_name:'order_refunds',column_name})):[]];
    if(o.query.includes('FULL OUTER JOIN')){if(failAudit)throw Object.assign(Error('access failed'),{code:403});return [overflow?Array.from({length:2001},()=>({orders:1})):[]];}
    return [[]];
  }};
}
test('typed reads are capped, aggregate only, and missing refund table is explicit',async()=>{
  const bigquery=fakeBigQuery();const r=await diagnoseShippingEvidence({start:'2026-09-01',end:'2026-09-30'},{bigquery,project:'gf-full-data'});
  assert.equal(r.financial_evidence_complete,false);
  assert.equal(r.checks.find(c=>c.stage==='shipping_refunds').status,'blocked');
  for(const o of bigquery.calls){assert.equal(o.types.start_date,'STRING');assert.equal(o.params.start_date,'2026-09-01');assert.equal(o.location,'EU');assert.equal(o.jobTimeoutMs,30000);assert.equal(o.maximumBytesBilled,'1000000000');}
  assert.equal(bigquery.calls.length,5);
});
test('partial failures and row overflow never produce reconciliation',async()=>{
  for(const cfg of [{failAudit:true},{overflow:true}]){
    const r=await diagnoseShippingEvidence({start:'2026-09-01',end:'2026-09-30'},{bigquery:fakeBigQuery(cfg),project:'gf-full-data'});
    assert.equal(r.checks.find(c=>c.stage==='population_audit').status,'rejected');assert.equal(r.reconciliation,undefined);assert.equal(r.financial_evidence_complete,false);
  }
});
test('refund evidence remains a contradiction check, with bounded deduplicated reads',async()=>{
  const bigquery=fakeBigQuery({refunds:true});const r=await diagnoseShippingEvidence({start:'2026-09-01',end:'2026-09-30'},{bigquery,project:'gf-full-data'});
  assert.equal(r.checks.find(c=>c.stage==='shipping_refunds').status,'fulfilled');assert.equal(bigquery.calls.length,7);
  assert.match(shippingRefundEvidenceSql('gf-full-data'),/PARTITION BY refund_id/);
  assert.match(r.interpretation.recovery,/cannot establish original charge or prove zero/);
});

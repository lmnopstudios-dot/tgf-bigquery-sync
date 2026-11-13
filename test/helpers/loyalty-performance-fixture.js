import {loyaltyFixture} from './loyalty-fixture.js';
import {createLoyaltyReportService} from '../../oracle/loyaltylion.js';
import {createOracleBaselineDispatcher} from '../../oracle/baseline-dispatcher.js';
import {createBaselineOverviewService} from '../../oracle/baseline-overview.js';
const now=Date.parse('2026-11-13T12:00:00Z');
export function performanceFixture(failed){
 const f=loyaltyFixture(),read=f.bigquery.query;
 f.bigquery.query=async q=>{
  if(!q.labels.operation.startsWith('performance_'))return read(q);
  f.queries.push(q);const op=q.labels.operation.slice(12);
  if(op===failed)throw Error('private source details');
  const period='Requested period',channel='online',currency='GBP';
  const rows={usage:[{period,month:'2026-10-01',resource:'activity',point_movements:10,participants:2,approved_delta:30,pending_delta:0,net_delta:30,observed_claimants:0}],enrolments:[{period,month:'2026-10-01',observed_enrolments:2}],purchasing:[{period,start_date:'2025-11-01',end_date:'2026-10-31',membership_basis:'current_member',channel,currency,month:'Full period',purchasing_customers:2,eligible_orders:3,repeat_purchasers:1,observed_period_repeat_rate:0.5,observed_orders_per_customer:1.5,original_order_gross:300,observed_aov:100,retained_lifetime_refunds:0}],cohorts:[{period,enrolment_month:'2026-01-01',window_days:30,channel,currency,customer_history:'existing_observed_customer',mature_customers:2,before_orders:3,after_orders:1,zero_before_customers:0,zero_after_customers:1,customers_purchasing_after:1,required_start_at:'2025-12-02T00:00:00Z',required_end_exclusive:'2026-01-31T00:00:00Z'}],linkage:[{period,outcome:'order_absent',point_records:2,distinct_movements:2}]};
  return [rows[op]];
 };
 f.provider=createLoyaltyReportService({bigquery:f.bigquery,project:'fixture',config:f.config,env:{LOYALTYLION_REPORTING_ENABLED:'true'},now:()=>new Date(now).toISOString()});
 f.baseline=createOracleBaselineDispatcher({ecommerceBaselineOverview:createBaselineOverviewService({loyalty:f.provider,now:()=>new Date(now)})});return f;
}

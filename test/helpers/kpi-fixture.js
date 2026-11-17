import {exportJsonWire} from './export-json-wire.js';
import {createKpiDashboard} from '../../oracle/kpi-dashboard.js';
import {createOracleBaselineDispatcher} from '../../oracle/baseline-dispatcher.js';
export const KPI_NOW=Date.parse('2026-11-17T12:00:00Z');
export const KPI_COVERAGE=[{source:'shopify',channel:'all',start_at:'2025-01-01T00:00:00Z',end_exclusive:'2026-11-17T00:00:00Z',evidence_reference:'fixture reviewed source manifest'}];
export function kpiFixture({failed=null,coverage=KPI_COVERAGE,failReadbackOnce=false}={}){
 const calls=[],wire=exportJsonWire();let failReadback=false;
 const exportStore={get:async(...args)=>{if(failReadback){failReadback=false;throw Error('Synthetic readback failure');}return wire.store.get(...args);},put:async(...args)=>{await wire.store.put(...args);if(failReadbackOnce)failReadback=true;}};
 const read=async args=>{calls.push(args);const commerce=args.periods.flatMap(p=>['GBP','USD'].filter(c=>!args.scope.currency||args.scope.currency===c).map(currency=>({period:p.id,currency,orders:p.id==='baseline'?20:4,gross:p.id==='baseline'?'3000.00':'1000.00',missing_values:0,customers:2,customerless_orders:1,observed_returning_customers:1,first_observed_customers:1,mean_gap:2.5,median_gap:2,intervals:2,interval_customers:1,required_gap_start:p.start_date,finance_observed_at:'2026-11-16T12:00:00Z',customer_observed_at:'2026-11-16T12:00:00Z',channel_observed_at:'2026-11-16T12:00:00Z'})));
 return {commerce:failed==='commerce'?{rows:[],failure:'accessDenied'}:{rows:commerce},retention:failed==='retention'?{rows:[],failure:'invalidQuery'}:{rows:args.periods.flatMap(p=>[30,60,90].map(horizon=>({period:p.id,currency:'GBP',horizon,cohort_customers:5,mature_customers:4,returned_customers:2})))}};};
 const service=createKpiDashboard({read,artifactStore:exportStore,coverage,baselineStart:'2025-01-01'});
 return {calls,exportStore,service,baseline:createOracleBaselineDispatcher({kpiDashboard:service}),generateProposals:()=>{throw Error('KPI must not propose knowledge');}};
}

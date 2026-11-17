// Presentation-only grouping. This never upgrades unknown customers or coverage.
const num=value=>value==null?null:Number.isFinite(Number(value))?Number(value):null;
export function kpiReadiness(e,currency){
 const summary=(e.summary||[]).filter(r=>r.currency==null||r.currency===currency),selected=summary.filter(r=>r.period==='selected'),mtd=summary.filter(r=>r.period==='mtd');
 const available=rows=>rows.filter(r=>r.status==='supported'&&r.value!=null),pending=rows=>rows.filter(r=>r.status!=='supported'||r.value==null);
 const observed=(e.rows||[]).find(r=>r.period==='selected'&&r.currency===currency&&r.metric==='aov'),customers=num(observed?.purchasing_customers),known=num(observed?.observed_returning_customers),first=num(observed?.first_observed_customers);
 const classification=observed?.source_reconciled===true&&customers>0&&known!=null&&first!=null&&known+first===customers?{customers,known,first,customerless:num(observed.customerless_orders),known_share_minimum:known/customers}:null;
 return {selected,selected_available:available(selected),selected_pending:pending(selected),mtd,mtd_available:available(mtd),mtd_pending:pending(mtd),classification};
}
export function kpiBaselineValue(e,row){
 if(e.baseline?.fixed)return {label:'Fixed baseline',value:row.baseline_value??null};
 const r=(e.rows||[]).find(r=>r.period==='baseline'&&r.metric===row.metric&&r.currency===row.currency&&r.geography===row.geography);
 if(row.metric==='conversion'&&r?.status==='supported'&&row.measurement_era!==r.measurement_era)return {label:'Proposed baseline (not fixed)',value:null,reason:'Session measurement eras differ; baseline comparison withheld'};
 return {label:'Proposed baseline (not fixed)',value:r?.status==='supported'?r.value:null};
}
export function kpiNextStep(row){
 if(row.reason==='Commerce interval is not source-reconciled')return 'Reconcile the missing source dates before enabling this period. A successful collection alone does not certify it.';
 if(row.metric==='conversion')return 'Review Shopify reporting access, returned-day coverage and measurement-era exclusions. Converted-session counts must come from the same human-session report; no GA4 purchase-event fallback is used.';
 if(row.metric==='turnover')return 'Bind merchandise sales, tax and refund-occurrence measures with consistent dates.';
 if(['returning_rate','new_customers'].includes(row.metric))return 'Audit earlier cross-platform purchasing history. First-observed customers are not necessarily new.';
 return 'Review the definition and coverage gap; do not substitute zero.';
}

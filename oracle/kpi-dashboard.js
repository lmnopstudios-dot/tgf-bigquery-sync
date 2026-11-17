import {assertWorksheetEvidence} from './workbook-evidence.js';
import ExcelJS from 'exceljs';
import {createHash} from 'node:crypto';
import {kpiRequest,kpiPeriods,monthAdd,dayAdd,validDay} from '../public/oracle/kpi-intent.js';
import {resolveAnalyticalPlan,assertPlanAgreement,stableAnalyticalJSON} from './analytical-plan.js';
import {kpiCovered,kpiInstantCovered,safeKpiFailure} from './kpi-reader.js';
import {priorityArtifactId} from './product-priority-storage.js';
export const KPI_DEFINITIONS=[
 ['Scope','Shopify retained orders only. Online, Shopify POS and combined (including Unknown) stay explicit. Currencies are separate; no FX conversion.'],
 ['AOV','Observed original discounted order gross including tax and shipping, before refunds, divided by distinct qualifying orders. Merchandise-only AOV is unavailable from this binding.'],
 ['Turnover','Unavailable: compatible merchandise sales, tax and refund-event-date allocation are not established together. Retained lifetime refunds are never substituted.'],
 ['Conversion','Unavailable: retained GA4 ecommercePurchases / sessions is purchases per session, not purchase-converted sessions / sessions. Combined, UK and International require that exact governed numerator and compatible session geography.'],
 ['Customers','Native Shopify customer IDs only; no fuzzy joins. Customerless orders contribute to order AOV but not customer denominators. Earlier Woo/Square histories are not combined.'],
 ['Returning','Primary returning/new customer rates are withheld without complete prior purchase history. Observed returning = an identifiable customer with a retained qualifying order before the period; first observed is not verified new.'],
 ['Order intervals','Elapsed days between consecutive qualifying orders in selected channel/currency, attributed to the later order date. Same-timestamp distinct orders have a zero gap. Mean and median are interval-weighted, with customers and intervals shown; non-returners have no interval.'],
 ['Repeat purchase','Index = first qualifying purchase in each selected period/channel/currency, not necessarily first-ever purchase. 30/60/90 days use elapsed time. Only customers with full observed follow-up enter the denominator; immature customers are reported separately.'],
 ['Comparisons','Calendar months compare with the preceding full calendar month. Other ranges use preceding equal calendar-day counts. Prior-year dates clamp 29 February to 28 February. MTD ends yesterday; prior-month/year endpoints clamp to month length. Actual dates and day counts are exposed.'],
 ['Baseline','First three consecutive verified full months are proposed from reviewed coverage. ORACLE_KPI_BASELINE_START freezes the approved first month; no automatic configuration write. Baseline AOV pools gross/orders; medians are not averaged. Targets remain unset.'],
 ['Coverage','Source-reconciled intervals are reused only for their exact channels and instants. A successful read or latest observed timestamp does not certify complete history. Missing evidence is blank, never zero. No causal programme impact is inferred.'],
 ['Geography','GA4 traffic geography differs from shipping destination. Commerce geography filters are unavailable until a compatible governed destination binding is added; no currency or market proxy is used.'],
 ['Acquisition cost','Unavailable: compatible governed spend and attribution are not bound. No CAC or business target has been invented.']
];
const metrics=[['aov','Observed gross AOV'],['returning_rate','Returning customer rate'],['new_customers','Verified new customers'],['order_frequency','Orders per purchasing customer'],['mean_gap','Mean days between orders'],['median_gap','Median days between orders'],['turnover','Turnover']];
const div=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b>0?a/b:null;
// Do not silently round large warehouse decimal strings through JS Number.
const number=v=>{if(v==null)return null;if(typeof v==='number')return Number.isFinite(v)?v:null;const s=String(v);if(s.replace(/[-.]/g,'').replace(/^0+/,'').replace(/0+$/,'').length>15)return null;return Number.isFinite(Number(v))?Number(v):null;};
export function kpiChange(a,b){if(a==null||b==null)return {absolute:null,percentage:null,direction:'unavailable'};const d=a-b;return {absolute:d,percentage:b===0?null:d/Math.abs(b),direction:d>0?'up':d<0?'down':'flat'};}
export function baselinePeriod(coverage,channel,pinned){
 let start=pinned;
 if(start&&(!validDay(start)||!start.endsWith('-01')))throw Object.assign(Error('Invalid KPI baseline'),{code:'KPI_BASELINE_INVALID'});
 if(!start){const dates=coverage.filter(c=>c.channel==='all'||channel==='combined'||c.channel===channel).map(c=>c.start_at.slice(0,10)).sort();if(!dates.length)return null;start=dates[0].slice(0,7)+'-01';if(start<dates[0])start=monthAdd(start,1);}
 for(let i=0;i<(pinned?1:120);i++,start=monthAdd(start,1)){
  const p={id:'baseline',label:pinned?'Fixed baseline':'Proposed baseline (approval not persisted)',start_date:start,end_date:dayAdd(monthAdd(start,3),-1)};
  if(kpiCovered(coverage,p,channel))return {...p,fixed:Boolean(pinned)};
 }
 return null;
}
export function buildKpiEvidence({context,periods,data,coverage,baseline,now}){
 const scope=context.kpi_scope,currencies=scope.currency?[scope.currency]:[...new Set(data.commerce.rows.map(r=>r.currency))].sort();if(!currencies.length)currencies.push('GBP');
 const rows=[];
 for(const p of periods)for(const currency of currencies){
  const r=data.commerce.rows.find(r=>r.period===p.id&&r.currency===currency),certified=kpiCovered(coverage,p,scope.channel),baseReason=data.commerce.failure||(!certified?'Commerce interval is not source-reconciled':null);
  const reason=baseReason||(!r?'No observed eligible orders':null),gross=number(r?.gross),orders=number(r?.orders),customers=number(r?.customers);
  const gapCovered=r?.required_gap_start&&kpiCovered(coverage,{...p,start_date:r.required_gap_start},scope.channel);
  const values={aov:!reason&&Number(r.missing_values)===0?div(gross,orders):null,returning_rate:null,new_customers:null,order_frequency:!reason?div(orders-(number(r?.customerless_orders)||0),customers):null,mean_gap:!reason&&gapCovered?number(r?.mean_gap):null,median_gap:!reason&&gapCovered?number(r?.median_gap):null,turnover:null};
  for(const [metric,label] of metrics){
   const why=metric==='turnover'?'Merchandise and refund-event-date components unavailable':metric==='returning_rate'||metric==='new_customers'?'Complete prior history unavailable; first observed is not verified new':reason||(metric.includes('gap')&&!gapCovered?'Consecutive-order lookback interval is not certified':values[metric]==null?'Missing compatible values or no eligible denominator':null);
   rows.push({period:p.id,period_label:p.label,start_date:p.start_date,end_date:p.end_date,metric,label,currency,channel:scope.channel,value:values[metric],status:why?'unavailable':'supported',reason:why,orders:orders??null,purchasing_customers:customers??null,customerless_orders:r?.customerless_orders??null,observed_returning_customers:r?.observed_returning_customers??null,first_observed_customers:r?.first_observed_customers??null,intervals:r?.intervals??null,interval_customers:r?.interval_customers??null,target:null,finance_observed_at:r?.finance_observed_at??null,customer_observed_at:r?.customer_observed_at??null,channel_observed_at:r?.channel_observed_at??null,source_reconciled:certified});
  }
 }
 for(const p of periods)for(const geography of ['combined','uk','international'])rows.push({period:p.id,period_label:p.label,start_date:p.start_date,end_date:p.end_date,metric:'conversion',label:'Online conversion / '+geography,currency:null,channel:'online',geography,value:null,sessions:null,converted_sessions:null,status:'unavailable',reason:'Governed purchase-converted session numerator unavailable; purchases per session was not substituted',target:null});
 const compare=(r,id)=>rows.find(x=>x.period===id&&x.metric===r.metric&&x.currency===r.currency&&x.geography===r.geography)?.value??null;
 const summary=rows.filter(r=>['selected','mtd'].includes(r.period)).map(r=>({...r,previous_value:compare(r,r.period==='mtd'?'mtd_previous':'previous'),year_value:compare(r,r.period==='mtd'?'mtd_year':'year'),baseline_value:baseline?.fixed?compare(r,'baseline'):null,previous_change:kpiChange(r.value,compare(r,r.period==='mtd'?'mtd_previous':'previous')),year_change:kpiChange(r.value,compare(r,r.period==='mtd'?'mtd_year':'year'))}));
 const retention=[];
 for(const p of periods)for(const currency of currencies)for(const horizon of [30,60,90]){
  const r=data.retention.rows.find(r=>r.period===p.id&&r.currency===currency&&Number(r.horizon)===horizon),follow={...p,end_date:dayAdd(p.end_date,horizon)},full=kpiCovered(coverage,p,scope.channel)&&(r?.mature_start_epoch!=null&&r?.mature_end_epoch!=null?kpiInstantCovered(coverage,new Date(Number(r.mature_start_epoch)*1000).toISOString(),new Date(Number(r.mature_end_epoch)*1000).toISOString(),scope.channel):kpiCovered(coverage,follow,scope.channel)),mature=number(r?.mature_customers),cohort=number(r?.cohort_customers),reason=data.retention.failure||(!full?'Full index and follow-up interval is not certified':null)||(!mature?'No fully mature customers':null);
  retention.push({period:p.id,currency,channel:scope.channel,horizon_days:horizon,index_definition:'First qualifying order in period',cohort_customers:cohort,mature_customers:mature,immature_customers:cohort==null||mature==null?null:cohort-mature,returned_customers:r?.returned_customers??null,repeat_rate:reason?null:div(number(r?.returned_customers),mature),status:reason?'unavailable':'supported',reason});
 }
 return {kind:'kpi_dashboard',subject:'kpi_tracking',start_date:context.start_date,end_date:context.end_date,periods,scope,analytical_plan:resolveAnalyticalPlan(context),generated_at:new Date(now).toISOString(),summary,monthly:rows.filter(r=>r.period.startsWith('month:')),rows,retention,baseline:baseline||{status:'unavailable',reason:'Three consecutive verified months unavailable'},definitions:KPI_DEFINITIONS,source_status:{commerce:data.commerce.failure||'read_completed',retention:data.retention.failure||'read_completed',conversion:'unavailable'},comparison_policy:KPI_DEFINITIONS.find(r=>r[0]==='Comparisons')[1]};
}
export function kpiWorkbookTables(e){return [['KPI summary',e.summary.map(({previous_change,year_change,...r})=>({...r,previous_change_absolute:previous_change.absolute,previous_change_percentage:previous_change.percentage,previous_direction:previous_change.direction,year_change_absolute:year_change.absolute,year_change_percentage:year_change.percentage}))],['Monthly trends',e.monthly],['Customer retention',e.retention],['Definitions and coverage',[...e.definitions.map(([definition,meaning])=>({definition,meaning})),{definition:'Generated at',meaning:e.generated_at},{definition:'Baseline',meaning:stableAnalyticalJSON(e.baseline)},...e.periods.map(p=>({definition:p.label,meaning:`${p.start_date} to ${p.end_date}; ${(Date.parse(p.end_date)-Date.parse(p.start_date))/86400000+1} calendar days`})),...e.rows.filter(r=>r.metric==='aov').map(r=>({definition:`${r.period} / ${r.currency} coverage`,meaning:r.source_reconciled?'Source-reconciled interval':r.reason,finance_observed_at:r.finance_observed_at,customer_observed_at:r.customer_observed_at,channel_observed_at:r.channel_observed_at}))]]];}
const kpiArtifactFailure=()=>Object.assign(Error('KPI_ARTIFACT_INVALID'),{code:'KPI_ARTIFACT_INVALID',failed_stage:'kpi_export_validation'});
export async function assertKpiArtifact(a){
 if(!a?.analysis_context||a.envelope?.kind!=='kpi_dashboard')throw kpiArtifactFailure();assertPlanAgreement(a.analysis_context,a.envelope);
 if(stableAnalyticalJSON(a.envelope.scope)!==stableAnalyticalJSON(a.analysis_context.kpi_scope)||a.envelope.start_date!==a.analysis_context.start_date||a.envelope.end_date!==a.analysis_context.end_date)throw kpiArtifactFailure();
 const bytes=Buffer.from(a.xlsx_base64||'','base64');if(createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw kpiArtifactFailure();
 const w=new ExcelJS.Workbook();try{await w.xlsx.load(bytes);}catch{throw kpiArtifactFailure();}const expected=kpiWorkbookTables(a.envelope);
 if(w.worksheets.length!==expected.length)throw kpiArtifactFailure();
 // Baseline is the only JSON-encoded explanatory cell. Legacy exports used
 // insertion-order JSON; compare that cell structurally, keeping other text exact.
 const normalise=(value,row,key)=>{if(row.definition==='Baseline'&&key==='meaning'&&typeof value==='string'){try{return stableAnalyticalJSON(JSON.parse(value));}catch{}}return value;};
 for(const [name,rows] of expected)assertWorksheetEvidence(w.getWorksheet(name),rows,kpiArtifactFailure,name==='Definitions and coverage'?normalise:undefined);
 return true;
}
export function createKpiDashboard({read,artifactStore,coverage=[],baselineStart=null}){
 return async(message,options={})=>{
  const context=options.analysisContext;if(context?.tool_route!=='get_kpi_dashboard')return null;
  const now=options.now??Date.now(),id=priorityArtifactId(options.exportOwner,options.requestId||message),scope=context.kpi_scope;
  let stage='kpi_export_read';
  const phase=name=>{stage=name;options.onProviderStage?.({stage:name,status:'started'});};
  try{
  phase(stage);
  let a=await artifactStore.get(id,options.exportOwner);
  if(a){assertPlanAgreement(context,a.envelope);await assertKpiArtifact(a);}
  else{
   phase('kpi_scope_validation');
   const baseline=baselinePeriod(coverage,scope.channel,baselineStart),periods=kpiPeriods(context.start_date,context.end_date,now);if(baseline)periods.push(baseline);
   phase('kpi_source_read');
   let data;try{data=await read({periods,scope,now,signal:options.signal,deadlineAt:options.deadlineAt,onProviderStage:options.onProviderStage});}catch(error){const failure=safeKpiFailure(error);data={commerce:{rows:[],failure},retention:{rows:[],failure}};}
   for(const [source,r] of Object.entries(data))options.onProviderStage?.({stage:'kpi_source',source,status:r.failure?'unavailable':'completed',...(r.failure?{code:r.failure}:{aggregate_rows:r.rows.length})});
   options.signal?.throwIfAborted();
   phase('kpi_workbook_build');
   const e=buildKpiEvidence({context,periods,data,coverage,baseline,now}),w=new ExcelJS.Workbook();w.creator='The Great Frog Oracle';
   for(const [name,rows] of kpiWorkbookTables(e)){const s=w.addWorksheet(name),keys=[...new Set(rows.flatMap(Object.keys))];s.columns=keys.map(key=>({header:key,key,width:/reason|meaning/.test(key)?65:25}));rows.forEach(r=>s.addRow(r));s.getRow(1).font={bold:true};s.views=[{state:'frozen',ySplit:1}];}
   const bytes=Buffer.from(await w.xlsx.writeBuffer());const supported=e.summary.filter(r=>r.status==='supported').length;
   const figures=e.summary.filter(r=>r.period==='selected'&&r.status==='supported').map(r=>`${r.label} (${r.currency}): ${r.value.toFixed(2)}`).join('; ');
   a={analysis_context:context,request:message,envelope:e,answer:`KPI dashboard: ${context.start_date} to ${context.end_date}, inclusive (London). ${figures?figures+'. ':''}${supported} supported KPI values across selected period and separate MTD; currencies remain separate. Conversion, merchandise turnover and verified new/returning classification need additional governed evidence. Current source reads do not extend certified history. See the dashboard and workbook for comparisons, denominators and gaps.`,filename:'oracle-kpi-dashboard.xlsx',sha256:createHash('sha256').update(bytes).digest('hex'),xlsx_base64:bytes.toString('base64')};
   phase('kpi_export_validation');await assertKpiArtifact(a);await options.assertLease?.();
   phase('kpi_export_persistence');await artifactStore.put(id,options.exportOwner,a);
   phase('kpi_export_readback');a=await artifactStore.get(id,options.exportOwner);await assertKpiArtifact(a);
  }
  phase('kpi_delivery_ready');
  return {answer:a.answer,tools:['get_kpi_dashboard'],partial:a.envelope.summary.some(r=>r.status!=='supported'),evidence:a.envelope,analysis_context:a.analysis_context,artifact:{id,filename:a.filename,row_count:a.envelope.rows.length,download_url:`/api/oracle/exports/${id}`}};
  }catch(error){if(!error.code)error.code='KPI_REPORT_FAILED';error.failed_stage??=stage;throw error;}
 };
}

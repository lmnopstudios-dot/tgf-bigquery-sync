import { resolveExecutionPlan } from './analytical-capabilities.js';
import { safeReadFailure, readFailureAction } from './read-failure.js';
import { boundedEvidenceRead } from './bounded-evidence-read.js';
import { createHash } from 'node:crypto';
import { numericDistribution, minorUnits, validateNumericOperation } from './numeric-distribution.js';
import { ORDER_VALUE_DEFINITIONS, ORDER_VALUE_ROW_BOUND } from './order-value-provider.js';
import { resolveAnalyticalPlan, assertPlanAgreement, stableAnalyticalJSON } from './analytical-plan.js';
import { resolvePromotionDates, retrievePromotionContext } from './promotion-context.js';
import { reportWorkbook } from './report-export.js';
import { priorityArtifactId } from './product-priority-storage.js';
import { withOracleCharts } from './evidence-charts.js';

export const BREAK_EVEN_DEFINITION=Object.freeze({status:'conditional',revenue_formula:'Incremental merchandise revenue required = (shipping revenue forgone + incremental fulfilment cost + other incremental costs) / positive contribution margin rate',orders_formula:'Incremental orders required = incremental revenue required / positive assumed incremental merchandise AOV',conversion_formula:'Conversion uplift required = incremental orders required / compatible eligible sessions',required_inputs:'Compatible product costs and contribution margin; fulfilment costs; incremental merchandise AOV; compatible eligible session denominator',assumption_policy:'Explicit user-supplied sensitivity assumptions are unvalidated, not forecasts. Unknown shipping charges make the recorded numerator partial.'});
export function orderValueWorkbookTables(e){
  if(e.sections.some(s=>!s.observed_merchandise))return [];
  return [['Order statistics',e.sections.map(s=>({comparison:s.label,...s.observed_merchandise}))],['Component outcomes',e.components],['Break-even',e.break_even?Object.entries(e.break_even).map(([component,definition])=>({component,definition})):[]]];
}
export const orderValueScenarioRows=sections=>sections.flatMap(s=>s.scenarios.map(({basket_gaps,...r})=>({comparison:s.label,...r,observed_merchandise_median:s.observed_merchandise.median,merchandise_valid_orders:s.observed_merchandise.valid_orders,merchandise_unknown_orders:s.observed_merchandise.unknown_orders})));
export const orderValueGapRows=sections=>sections.some(s=>!s.observed_merchandise)?sections.flatMap(s=>s.gaps.map(g=>({comparison:s.label,...g}))):sections.flatMap(s=>s.scenarios.flatMap(r=>(r.basket_gaps||[]).map(g=>({comparison:s.label,threshold:r.threshold,...g}))));
export function orderValueComponentOutcomes(context,evidence) {
  return resolveExecutionPlan(context).components.map(c=>{
    if(['unsupported','blocked'].includes(c.status))return {...c,status:'unavailable'};
    if(c.operation==='break_even')return {...c,status:'conditional',detail:'Formula available; compatible costs, margin and behavioural inputs required.'};
    if(evidence.retrieval_failed&&c.operation!=='optional_product_enrichment')return {...c,status:'failed',detail:'Order population retrieval failed; no new metric calculated.'};
    if(c.operation==='optional_product_enrichment'){
      const retrieval=evidence.retrieval.find(r=>r.component==='published_prices');
      return {...c,status:retrieval?.status==='rejected'||evidence.catalogue?.error_code?'failed':!evidence.catalogue?.complete?'unavailable':'conditional',detail:'Current published destination prices only; historical baskets and product relationships remain separate.'};
    }
    if(!evidence.sections?.some(s=>s.population>0))return {...c,status:'unavailable',detail:'No retrieved eligible order values; empty coverage unverified.'};
    if(['merchandise_mean','merchandise_median'].includes(c.operation)&&!evidence.sections.some(s=>s.observed_merchandise.valid_orders>0))return {...c,status:'unavailable',detail:'No valid merchandise amounts; unknown counts disclosed.'};
    return c;
  });
}
const mismatch=()=>{throw Object.assign(Error('Order-value evidence differs from validated scope'),{code:'EVIDENCE_SCOPE_MISMATCH'});};
const esc=x=>String(x??'Unavailable').replaceAll('|','\\|').replace(/[<>\r\n]/g,' ');
const number=x=>x==null?'Unavailable':Number(x).toLocaleString('en-GB',{maximumFractionDigits:2});
const money=(x,c)=>x==null?'Unavailable':`${c} ${number(x)}`;
export function orderValueBusinessView(e) {
  const verified=e.coverage?.complete===true&&e.coverage?.population_complete==='verified';
  const hasPopulation=e.sections?.some(s=>s.population>0);
  const c=e.currency,lines=[e.retrieval_failed?'Order-value evidence could not be retrieved; no threshold effect was calculated.':e.sections?.[0]?.population_status==='unverified_empty_population'?'No threshold effect can be calculated from an unverified empty population.':'These are conditional scenarios on the named observed amount. The actual shipping-rule basis is unverified, so a profit-optimal threshold cannot be recommended.',`Basis: ${e.basis==='observed_subtotal'?'Observed discounted merchandise subtotal (shipping excluded; tax inclusion unverified)':'Observed order total (includes shipping and tax according to source semantics)'} · ${esc(c)} · direct ${esc(e.country)} shipping destinations · candidate online population (retail_location_id IS NULL; Online Store attribution unverified). Collection completeness is ${verified?'verified for this scope':'unverified'}.${hasPopulation?' Shares use all retrieved eligible orders, including unknown values.':''}`];
  if(!e.retrieval_failed&&e.sections?.[0]?.population_status==='unverified_empty_population')lines.push('No eligible orders were retrieved from the collected evidence. Missing components and unverified coverage may limit this result; it does not establish zero orders in the source. Run the bounded order-value coverage diagnostic for this country, currency and window to check financial, status and geography matches before retrying.');
  for(const section of e.sections||[]){
    lines.push(section.label);
    const observed=section.observed_merchandise;
    if(observed)lines.push(`Exact observed merchandise average order value (AOV): ${money(observed.mean,c)}; median: ${money(observed.median,c)}. Valid-value denominator: ${observed.valid_orders} orders; unknown merchandise amounts: ${observed.unknown_orders}. Shipping excluded; tax inclusion unverified. Currency display rounds to two decimal places. These historical basket values stay unchanged across thresholds and are separate from current product prices.`);
    else lines.push('Exact observed merchandise mean and median were not calculated in this saved report. Request them explicitly to execute the new operations.');
    if(section.population_status==='unverified_empty_population'){lines.push('The collected eligible population is empty and coverage is unverified. Financial effects are unavailable; zero retrieved affected orders does not establish zero cost or zero source sales.');continue;}
    if(section.population_status==='verified_empty_eligible_population')lines.push('The eligible population is verified empty for this scope.');
    lines.push(['| Threshold | Newly eligible | Losing eligibility | Known shipping charges on affected orders* | Hypothetical fee* | Unknown charges | Other-charge orders |','|---:|---:|---:|---:|---:|---:|---:|',...section.scenarios.map(s=>`| ${money(s.threshold,c)} | ${number(s.newly_eligible)} | ${number(s.losing_eligibility)} | ${money(s.recorded_shipping_charges,c)} | ${money(s.hypothetical_fee,c)} | ${s.unknown_charge_orders} | ${s.non_standard_charge_orders} |`)].join('\n'));
    if(observed)lines.push(['| Threshold | Recorded shipping potentially forgone | Per eligible order (partial known sum) | Eligible denominator | Known charges | Unknown charges |','|---:|---:|---:|---:|---:|---:|',...section.scenarios.map(s=>`| ${money(s.threshold,c)} | ${money(s.recorded_shipping_potentially_forgone,c)} | ${money(s.recorded_shipping_per_eligible_order,c)} | ${s.shipping_denominator} | ${s.eligible_known_charge_orders||0} | ${s.eligible_unknown_charge_orders||0} |`)].join('\n'));
    lines.push('Shipping denominator: all retrieved orders with known observed value at or above each threshold, including unknown shipping charges. The numerator sums known recorded charges only; this conditional forgone amount is not delivery cost or a forecast.');
    lines.push(['| Threshold | Basket gap (lower exclusive, upper inclusive) | Orders in gap interval | Orders within upper gap |','|---:|---|---:|---:|',...section.scenarios.flatMap(s=>(s.basket_gaps||[]).map(g=>`| ${money(s.threshold,c)} | > ${money(g.lower,c)} to ≤ ${money(g.upper,c)} | ${g.orders} | ${g.within_orders} |`))].join('\n'));
    lines.push('Basket gap = threshold − observed amount. Only positive gaps count; baskets exactly at the threshold qualify and have no gap. Unknown amounts are excluded from gap counts and disclosed above.');
    lines.push(['| Observed value band | Orders | Share of retrieved population |','|---|---:|---:|',...section.bands.map(b=>`| ${b.upper==null?`${money(b.lower,c)} and above`:`${money(b.lower,c)} to < ${money(b.upper,c)}`} | ${b.orders} | ${b.population_share==null?'Unavailable':number(b.population_share*100)+'%'} |`),`| Unknown / ambiguous value | ${section.unknown_values} | ${section.population?number(section.unknown_values/section.population*100)+'%':'Unavailable'} |`].join('\n'));
    const count=section.gaps.reduce((n,g)=>n+g.orders,0),expensive=section.gaps.filter(g=>g.spend_exceeds_saving).reduce((n,g)=>n+g.orders,0);lines.push(`${count} retrieved baskets are 10–75 below the baseline ${money(e.operation.baseline,c)} on this basis. For ${expensive} of them, extra spend exceeds the assumed ${money(e.operation.assumed_charge,c)} shipping saving.`);
  }
  if(!e.retrieval_failed&&e.sections.some(s=>s.population_status!=='unverified_empty_population'))lines.push(`*Recorded charges are partial sums of known shipping charges on affected orders; unknown-charge counts are shown separately. These are shipping charges, not merchandise subtotal. Hypothetical fee = ${money(e.operation.assumed_charge,c)} × affected orders; it is neither expected lost fees nor expected new revenue. Existing orders and purchasing behaviour stay unchanged. Threshold equality qualifies. Historical exceptions are not errors or evidence of compliance with today's supplied policy.`);
  if(e.promotion?.status==='confirmed')lines.push('Confirmed promotion context: '+e.promotion.events.map(p=>`${esc(p.title)} (${esc(p.effective_from)} to ${esc(p.effective_to)})`).join('; ')+'. These dates do not establish a causal shipping or sales effect.');
  if(e.candidates?.length)lines.push('Current UK price-compatible candidates (publication does not establish availability; price compatibility is not a proven cross-sell or verified shipping qualification):\n'+e.candidates.slice(0,5).map(p=>`- ${esc(p.title)}: ${money(p.price,c)}; bridges ${p.compatible_baskets} retrieved gaps. ${p.price>e.operation.assumed_charge?'The price exceeds the shipping saving.':''}`).join('\n'));
  if(e.components?.length)lines.push(['| Requested component | Outcome | Detail |','|---|---|---|',...e.components.map(x=>`| ${esc(x.operation)} | ${esc(x.status)} | ${esc(x.blocker||x.detail||'Retrieved evidence only; coverage and amount semantics disclosed above.')} |`)].join('\n'));
  if(e.break_even)lines.push('Break-even is conditional: required incremental merchandise revenue = (recorded shipping revenue forgone + incremental fulfilment cost + other incremental costs) / contribution margin rate, for a positive margin rate. Required incremental orders = revenue required / assumed incremental merchandise AOV, with a positive AOV. Required conversion uplift = incremental orders / compatible eligible sessions. Missing inputs: compatible product costs and contribution margin, fulfilment costs, incremental order value and session denominator. Unknown shipping charges make the recorded numerator partial. No validated forecast or optimal threshold follows. Explicit user-supplied sensitivity assumptions can support arithmetic, but remain unvalidated assumptions.');
  lines.push(...e.limitations);
  return lines;
}
function candidatesFor(catalogue,sections,currency){
  if(!catalogue?.complete)return [];
  const gaps=sections[0]?.gaps||[];
  return catalogue.products.flatMap(p=>(p.destination_prices||[]).filter(v=>v.currency===currency&&minorUnits(v.price)>0&&v.country==='GB').map(v=>({product_id:p.product_id,title:p.title,url:p.url,variant_id:v.variant_id,price:Number(v.price),product_type:p.product_type,compatible_baskets:gaps.filter(g=>minorUnits(g.spend_needed)<=minorUnits(v.price)).reduce((n,g)=>n+g.orders,0),classification:'price-compatible candidate; shipping qualification unverified'}))).filter(p=>p.compatible_baskets>0&&p.price<=75).sort((a,b)=>a.price-b.price||a.title.localeCompare(b.title)).slice(0,10);
}
function chartDatasets(e){return (e.sections||[]).filter(s=>s.population_status!=='unverified_empty_population').map((s,i)=>({id:`order-bands-${i}`,shape:'ranking',title:`Order-value bands: ${s.label}`,metric:'orders',unit:'count',definition:'Lower inclusive, upper exclusive; all retrieved eligible orders. Unknown values kept separately. Collection completeness unverified.'+(s.observed_merchandise?` Basis: ${e.basis}. ${s.label==='Sale-excluded comparison'?'Excluded calendar days: '+e.promotion.dates.join(', '):'Full period; no sale days excluded.'}`:''),source:'Persisted Shopify order components',population:s.observed_merchandise?`shopify/shopify · ${e.country} · ${e.currency} · candidate online population`:'shopify/shopify',period:`${e.periods[0].start_date} to ${e.periods[0].end_date}`,category_order:s.bands.map(b=>b.upper==null?`${b.lower}+`:`${b.lower}–<${b.upper}`),points:s.bands.map(b=>({label:b.upper==null?`${b.lower}+`:`${b.lower}–<${b.upper}`,value:b.orders}))}));}
export function assertOrderValueEvidence(context,e) {
  assertPlanAgreement(context,e);
  const newOperations=['merchandise_mean','merchandise_median','basket_gaps','break_even'];
  const legacy=e.sections?.some(s=>!s.observed_merchandise)&&!context.requested_operations?.some(op=>newOperations.includes(op));
  if(e.break_even!=null&&stableAnalyticalJSON(e.break_even)!==stableAnalyticalJSON(context.requested_operations?.includes('break_even')?BREAK_EVEN_DEFINITION:null))mismatch();
  if(context.requested_operations?.includes('break_even')&&!e.break_even)mismatch();
  const {observed_merchandise_statistics,basket_gaps,shipping_forgone,...oldDefinitions}=ORDER_VALUE_DEFINITIONS;
  if(!e?.analytical_plan||e.kind!=='governed_order_values'||e.requested_subject!=='order_values'||e.country!==context.geography||e.currency!==context.currencies[0]||e.source_store!=='shopify'||e.time_zone!==context.time_zone||e.basis!==context.numeric_operation.basis||stableAnalyticalJSON(e.operation)!==stableAnalyticalJSON(context.numeric_operation)||stableAnalyticalJSON(e.definitions)!==stableAnalyticalJSON(legacy?oldDefinitions:ORDER_VALUE_DEFINITIONS)||e.periods?.length!==1||e.periods[0].start_date!==context.start_date||e.periods[0].end_date!==context.end_date)mismatch();
  if(stableAnalyticalJSON(e.components)!==stableAnalyticalJSON(legacy?resolveExecutionPlan(context).components:orderValueComponentOutcomes(context,e)))mismatch();
  const promotion=resolvePromotionDates(e.promotion_source,context.promotion_context,e.periods[0]);
  if(stableAnalyticalJSON(promotion)!==stableAnalyticalJSON(e.promotion))mismatch();
  const rows=e.source_rows||[];for(const r of rows)if(r.date<context.start_date||r.date>context.end_date||!/^\d{4}-\d{2}-\d{2}$/.test(r.date))mismatch();
  const expected=e.retrieval_failed?[]:[{label:'Full period',...numericDistribution(rows,e.operation,e.coverage)},...(promotion.status==='confirmed'?[{label:'Sale-excluded comparison',...numericDistribution(rows.filter(r=>!promotion.dates.includes(r.date)),e.operation,e.coverage)}]:[])];
  // Legacy reports can recover their original operations, never answer new metrics.
  const legacyScenarioKeys=['threshold','newly_eligible','losing_eligibility','affected_orders','known_charge_orders','unknown_charge_orders','zero_charge_orders','non_standard_charge_orders','recorded_shipping_charges','hypothetical_fee','charge_total_complete','evidence_complete'];
  const validated=legacy?expected.map(({observed_merchandise,...s})=>({...s,scenarios:s.scenarios.map(r=>Object.fromEntries(legacyScenarioKeys.map(k=>[k,r[k]])))})):expected;
  const expectedRows=legacy?validated.flatMap(s=>s.scenarios.map(r=>({comparison:s.label,...r}))):orderValueScenarioRows(expected);
  if(stableAnalyticalJSON(validated)!==stableAnalyticalJSON(e.sections)||stableAnalyticalJSON(expectedRows)!==stableAnalyticalJSON(e.rows))mismatch();
  if(stableAnalyticalJSON(candidatesFor(e.catalogue,e.sections,e.currency))!==stableAnalyticalJSON(e.candidates))mismatch();
  if(e.chart_datasets&&stableAnalyticalJSON(chartDatasets(e))!==stableAnalyticalJSON(e.chart_datasets))mismatch();
  if(e.chart_specs&&stableAnalyticalJSON(withOracleCharts({answer:'',evidence:{...e,chart_specs:undefined}}).charts)!==stableAnalyticalJSON(e.chart_specs))mismatch();
}
// Keep each production query within its existing 366-day contract. Windows are
// disjoint; the shared evidence still represents the original requested dates.
async function retrievePopulation(provider,args,options){
  const day=86400000,end=Date.parse(args.end_date+'T00:00:00Z'),windows=[];
  for(let start=Date.parse(args.start_date+'T00:00:00Z');start<=end;start+=366*day){
    windows.push({start_date:new Date(start).toISOString().slice(0,10),end_date:new Date(Math.min(end,start+365*day)).toISOString().slice(0,10)});
    if(windows.length>4)throw Object.assign(Error('Order-value window bound exceeded'),{code:'ORDER_VALUE_READ_BOUND'});
  }
  if(windows.length===1)return provider(args,options);
  const parts=[];
  for(const window of windows){
    const requested={...args,...window},part=await provider(requested,options);
    if(stableAnalyticalJSON(part.scope)!==stableAnalyticalJSON({...requested,source_store:'shopify'})||part.rows.some(r=>r.date<window.start_date||r.date>window.end_date))mismatch();
    parts.push(part);
  }
  const rows=parts.flatMap(p=>p.rows);
  if(rows.length>ORDER_VALUE_ROW_BOUND)throw Object.assign(Error('Order-value row bound exceeded'),{code:'ORDER_VALUE_READ_BOUND'});
  const coverageParts=parts.map((p,i)=>({period:windows[i],...p.coverage}));
  const failure=parts.find(p=>p.coverage?.failure)?.coverage.failure;
  return {scope:{...args,source_store:'shopify'},rows,definitions:ORDER_VALUE_DEFINITIONS,coverage:{parts:coverageParts,complete:false,population_complete:'unverified',coverage_retrieval:failure?'rejected':'fulfilled',...(failure?{failure}:{}),...(parts.every(p=>p.coverage?.eligible_orders!=null)?{eligible_orders:parts.reduce((n,p)=>n+Number(p.coverage.eligible_orders),0)}:{})}};
}
export async function answerOrderValues({context,provider,productPrices,knowledgeService,exportStore,exportOwner,requestId,onEvidence,onProviderStage,signal,deadlineAt,now=()=>new Date()}){
  const operation=validateNumericOperation(context.numeric_operation),period={start_date:context.start_date,end_date:context.end_date};
  const args={...period,platform:'shopify',source_store:context.source_store,channel:context.channel||'online',time_zone:context.time_zone,country:context.geography,currency:context.currencies[0],basis:operation.basis,assumed_charge:operation.assumed_charge};
  const attempted=[Boolean(provider),false,false];
  const results=await Promise.allSettled([Promise.resolve().then(()=>{if(!provider)throw Error('Provider unavailable');return retrievePopulation(provider,args,{signal,deadlineAt,onProviderStage});}),boundedEvidenceRead(()=>{if(!context.promotion_context||context.promotion_context.treatment==='include'||!knowledgeService)return null;attempted[1]=true;return retrievePromotionContext(knowledgeService,context.promotion_context,period);},{signal,deadlineAt}),boundedEvidenceRead(()=>{if(!operation.enrich_products||context.geography!=='GB'||!productPrices)return null;attempted[2]=true;return productPrices({signal,deadlineAt,onProviderStage});},{signal,deadlineAt})]);
  const data=results[0].status==='fulfilled'?results[0].value:null,components=resolveExecutionPlan(context).components,limitations=components.filter(c=>c.status==='unsupported').map(c=>c.blocker);
  limitations.push('Scope: Shopify-only collected history in the requested window; WooCommerce and other stores are not combined. History before Shopify or missing collection is unverified. To answer for all platforms, specify the additional population and use compatible source-specific evidence.');
  limitations.push(`Illustrative scenario assumption used for this calculation: ${args.currency} ${operation.assumed_charge} below ${args.currency} ${operation.baseline}. This is not a confirmed business policy or a forecast.`);
  if(data){const expected={...args,source_store:'shopify'};if(stableAnalyticalJSON(data.scope)!==stableAnalyticalJSON(expected))mismatch();}
  const failure=!data?safeReadFailure(results[0].reason,'population_query'):null;
  if(failure)limitations.push(readFailureAction(failure));
  if(data?.coverage?.failure)limitations.push('Coverage checks could not be retrieved; calculated sections use retrieved orders only. '+readFailureAction(data.coverage.failure));
  const promotion_source=results[1].status==='fulfilled'?results[1].value:null,promotion=resolvePromotionDates(promotion_source,context.promotion_context,period);
  if(results[1].status==='rejected')limitations.push((promotion.status==='confirmed'?'Promotion knowledge retrieval failed; explicitly supplied calendar exclusions and both numeric sections are retained. ':'Promotion exclusions are unavailable because promotion evidence retrieval failed; full-period analysis is retained. ')+readFailureAction(safeReadFailure(results[1].reason,'promotion')));
  else if(!['confirmed','not_requested'].includes(promotion.status))limitations.push(promotion.clarification||'Promotion exclusions are unavailable. Full-period analysis is retained.');
  const source_rows=data?.rows||[],sections=data?[{label:'Full period',...numericDistribution(source_rows,operation,data.coverage)},...(promotion.status==='confirmed'?[{label:'Sale-excluded comparison',...numericDistribution(source_rows.filter(r=>!promotion.dates.includes(r.date)),operation,data.coverage)}]:[])]:[];
  const catalogue=results[2].status==='fulfilled'?results[2].value:null,candidates=candidatesFor(catalogue,sections,args.currency);
  if(operation.enrich_products&&!candidates.length){
    if(results[2].status==='rejected')limitations.push('Published price retrieval failed; numeric sections are retained. '+readFailureAction(safeReadFailure(results[2].reason,'published_prices')));
    else if(catalogue?.error_code)limitations.push('Published price retrieval failed; numeric sections are retained. '+readFailureAction(safeReadFailure(catalogue.safe_failure||{code:catalogue.error_code,http_status:catalogue.status},'published_prices')));
    else if(!attempted[2]||!catalogue?.complete)limitations.push('Current published UK price enrichment is unavailable; complete destination prices are unverified. Retry price enrichment with a supported UK price provider; numeric sections are retained.');
    else limitations.push('No current published UK prices bridge the retrieved basket gaps within the candidate price range. Price compatibility is not a proven cross-sell.');
  }
  const analysis_context={...context,source_store:'shopify',...(context.promotion_context&&!['confirmed','not_requested'].includes(promotion.status)?{promotion_context:{...context.promotion_context,pending_dates:true,pending_endpoint_date:promotion.events.find(e=>e.interpretation?.endpoint_options)?.interpretation.established_end_date||null,pending_endpoint:promotion.status==='temporal_unresolved'&&Boolean(promotion.events.some(e=>e.interpretation?.endpoint_options))}}:{})};
  const evidence={kind:'governed_order_values',requested_subject:'order_values',metrics:['orders'],break_even:context.requested_operations.includes('break_even')?BREAK_EVEN_DEFINITION:null,periods:[period],source_store:'shopify',country:args.country,currency:args.currency,time_zone:args.time_zone,basis:operation.basis,operation,definitions:ORDER_VALUE_DEFINITIONS,components,analytical_plan:resolveAnalyticalPlan(analysis_context),source_rows,sections,rows:orderValueScenarioRows(sections),coverage:data?.coverage||{complete:false,population_complete:'unverified'},promotion_source,promotion,catalogue,candidates,limitations,retrieval_failed:!data,failure,retrieval:results.map((r,i)=>({component:['population','promotion','published_prices'][i],attempted:attempted[i],status:i===2&&catalogue?.complete===false?'incomplete':(i===1&&(!context.promotion_context||context.promotion_context.treatment==='include')||i===2&&!operation.enrich_products)?'not_requested':!attempted[i]?'unavailable':r.status,...(i===2&&catalogue?.error_code?{failure:catalogue.safe_failure||safeReadFailure({code:catalogue.error_code,http_status:catalogue.status},'published_prices')}:{}),...(r.status==='rejected'?{failure:safeReadFailure(r.reason,['population_query','promotion','published_prices'][i])}:{})})),generated_at:new Date(now()).toISOString()};
  evidence.components=orderValueComponentOutcomes(analysis_context,evidence);
  if(data?.coverage?.eligible_orders!=null&&Number(data.coverage.eligible_orders)!==sections[0].population)mismatch();
  evidence.chart_datasets=chartDatasets(evidence);
  assertOrderValueEvidence(analysis_context,evidence);
  let result=withOracleCharts({analysis_context,analysis_unavailable:!data||sections[0]?.population_status==='unverified_empty_population',partial:Boolean(data&&(context.platform!=='shopify'||context.channel!=='online'||evidence.components.some(c=>['unavailable','failed'].includes(c.status))||operation.enrich_products&&!catalogue?.complete||sections[0]?.population_status==='unverified_empty_population'||results.some(r=>r.status==='rejected')||data.coverage?.coverage_retrieval==='rejected')),answer:orderValueBusinessView(evidence).join('\n\n'),tools:['get_order_value_analysis'],evidence});
  onProviderStage?.({stage:'order_value_validation',status:data?'success':'unavailable',aggregate_groups:source_rows.length,synthesis_path:'validated_aggregate',model_calls:0});await onEvidence?.(result);
  if(context.output_preference==='xlsx'){
    if(!exportStore||!exportOwner||!requestId)return {...result,answer:result.answer+'\n\nExport storage is unavailable; retrieved figures are retained.'};
    const id=priorityArtifactId(exportOwner,requestId);
    try{
      const saved=await exportStore.get(id,exportOwner);if(saved){assertOrderValueEvidence(analysis_context,saved.envelope);if(createHash('sha256').update(Buffer.from(saved.xlsx_base64,'base64')).digest('hex')!==saved.sha256)mismatch();return withOracleCharts({...result,analysis_context:saved.analysis_context||analysis_context,answer:saved.answer,evidence:saved.envelope,artifact:{id,filename:saved.filename,row_count:saved.envelope.rows.length,download_url:`/api/oracle/exports/${id}`}});}
      const bytes=Buffer.from(await reportWorkbook({generated_at:evidence.generated_at,period,comparison:period,kpis:evidence.rows,additional_sheets:orderValueWorkbookTables(evidence),trend:sections.flatMap(s=>s.bands.map(b=>({comparison:s.label,...b}))),products:candidates,context:orderValueGapRows(sections),limitations:[...limitations,JSON.stringify(evidence.components),JSON.stringify(sections.map(s=>({comparison:s.label,...s.observed_merchandise}))),JSON.stringify(ORDER_VALUE_DEFINITIONS),JSON.stringify(evidence.coverage),JSON.stringify(promotion),JSON.stringify(evidence.analytical_plan)]}));
      const filename='oracle-order-value-scenarios.xlsx';await exportStore.put(id,exportOwner,{answer:result.answer,analysis_context,envelope:result.evidence,filename,sha256:createHash('sha256').update(bytes).digest('hex'),xlsx_base64:bytes.toString('base64')});result={...result,artifact:{id,filename,row_count:evidence.rows.length,download_url:`/api/oracle/exports/${id}`}};await onEvidence?.(result);
    }catch(error){if(error.code==='EVIDENCE_SCOPE_MISMATCH')throw error;result.answer+='\n\nExport persistence failed; analysis is retained. Retry the export explicitly.';}
  }
  return result;
}

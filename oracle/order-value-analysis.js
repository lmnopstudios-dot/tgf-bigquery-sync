import { boundedEvidenceRead } from './bounded-evidence-read.js';
import { createHash } from 'node:crypto';
import { numericDistribution, minorUnits, validateNumericOperation } from './numeric-distribution.js';
import { ORDER_VALUE_DEFINITIONS } from './order-value-provider.js';
import { resolveAnalyticalPlan, assertPlanAgreement, stableAnalyticalJSON } from './analytical-plan.js';
import { resolvePromotionDates, retrievePromotionContext } from './promotion-context.js';
import { reportWorkbook } from './report-export.js';
import { priorityArtifactId } from './product-priority-storage.js';
import { withOracleCharts } from './evidence-charts.js';

const mismatch=()=>{throw Object.assign(Error('Order-value evidence differs from validated scope'),{code:'EVIDENCE_SCOPE_MISMATCH'});};
const esc=x=>String(x??'Unavailable').replaceAll('|','\\|').replace(/[<>\r\n]/g,' ');
const number=x=>x==null?'Unavailable':Number(x).toLocaleString('en-GB',{maximumFractionDigits:2});
const money=(x,c)=>x==null?'Unavailable':`${c} ${number(x)}`;
export function orderValueBusinessView(e) {
  const c=e.currency,lines=[e.retrieval_failed?'Order-value evidence could not be retrieved; no threshold effect was calculated.':'These are conditional scenarios on the named observed amount. The actual shipping-rule basis is unverified, so a profit-optimal threshold cannot be recommended.',`Basis: ${esc(e.basis)} · ${esc(c)} · direct ${esc(e.country)} shipping destinations · governed online population. Collection completeness is unverified; shares use all retrieved eligible orders, including unknown values.`];
  for(const section of e.sections||[]){
    lines.push(section.label);
    lines.push(['| Threshold | Newly eligible | Losing eligibility | Recorded charges on affected orders* | Hypothetical fee* | Unknown charges | Other-charge orders |','|---:|---:|---:|---:|---:|---:|---:|',...section.scenarios.map(s=>`| ${money(s.threshold,c)} | ${number(s.newly_eligible)} | ${number(s.losing_eligibility)} | ${money(s.recorded_shipping_charges,c)} | ${money(s.hypothetical_fee,c)} | ${s.unknown_charge_orders} | ${s.non_standard_charge_orders} |`)].join('\n'));
    lines.push(['| Observed value band | Orders | Share of retrieved population |','|---|---:|---:|',...section.bands.map(b=>`| ${b.upper==null?`${money(b.lower,c)} and above`:`${money(b.lower,c)} to < ${money(b.upper,c)}`} | ${b.orders} | ${b.population_share==null?'Unavailable':number(b.population_share*100)+'%'} |`),`| Unknown / ambiguous value | ${section.unknown_values} | ${section.population?number(section.unknown_values/section.population*100)+'%':'Unavailable'} |`].join('\n'));
    const count=section.gaps.reduce((n,g)=>n+g.orders,0);lines.push(`${count} retrieved baskets are 10–75 below the baseline ${money(e.operation.baseline,c)} on this basis. Their extra spend exceeds the assumed ${money(e.operation.assumed_charge,c)} shipping saving.`);
  }
  lines.push(`*Recorded charges are the known subtotal when charge evidence is missing. Hypothetical fee = ${money(e.operation.assumed_charge,c)} × affected orders; it is neither expected lost fees nor expected new revenue. Existing orders and purchasing behaviour stay unchanged. Threshold equality qualifies. Historical exceptions are not errors or evidence of compliance with today's supplied policy.`);
  if(e.candidates?.length)lines.push('Current UK price-compatible candidates (publication does not establish availability; price compatibility is not a proven cross-sell or verified shipping qualification):\n'+e.candidates.slice(0,5).map(p=>`- ${esc(p.title)}: ${money(p.price,c)}; bridges ${p.compatible_baskets} retrieved gaps. ${p.price>e.operation.assumed_charge?'The price exceeds the shipping saving.':''}`).join('\n'));
  lines.push(...e.limitations);
  return lines;
}
function candidatesFor(catalogue,sections,currency){
  if(!catalogue?.complete)return [];
  const gaps=sections[0]?.gaps||[];
  return catalogue.products.flatMap(p=>(p.destination_prices||[]).filter(v=>v.currency===currency&&minorUnits(v.price)>0&&v.country==='GB').map(v=>({product_id:p.product_id,title:p.title,url:p.url,variant_id:v.variant_id,price:Number(v.price),product_type:p.product_type,compatible_baskets:gaps.filter(g=>minorUnits(g.spend_needed)<=minorUnits(v.price)).reduce((n,g)=>n+g.orders,0),classification:'price-compatible candidate; shipping qualification unverified'}))).filter(p=>p.compatible_baskets>0&&p.price<=75).sort((a,b)=>a.price-b.price||a.title.localeCompare(b.title)).slice(0,10);
}
function chartDatasets(e){return (e.sections||[]).map((s,i)=>({id:`order-bands-${i}`,shape:'ranking',title:`Order-value bands: ${s.label}`,metric:'orders',unit:'count',definition:'Lower inclusive, upper exclusive; all retrieved eligible orders. Unknown values kept separately. Collection completeness unverified.',source:'Persisted Shopify order components',population:'shopify/shopify',period:`${e.periods[0].start_date} to ${e.periods[0].end_date}`,category_order:s.bands.map(b=>b.upper==null?`${b.lower}+`:`${b.lower}–<${b.upper}`),points:s.bands.map(b=>({label:b.upper==null?`${b.lower}+`:`${b.lower}–<${b.upper}`,value:b.orders}))}));}
export function assertOrderValueEvidence(context,e) {
  assertPlanAgreement(context,e);
  if(!e?.analytical_plan||e.kind!=='governed_order_values'||e.requested_subject!=='order_values'||e.country!==context.geography||e.currency!==context.currencies[0]||e.source_store!=='shopify'||e.time_zone!==context.time_zone||e.basis!==context.numeric_operation.basis||stableAnalyticalJSON(e.operation)!==stableAnalyticalJSON(context.numeric_operation)||stableAnalyticalJSON(e.definitions)!==stableAnalyticalJSON(ORDER_VALUE_DEFINITIONS)||e.periods?.length!==1||e.periods[0].start_date!==context.start_date||e.periods[0].end_date!==context.end_date)mismatch();
  const promotion=resolvePromotionDates(e.promotion_source,context.promotion_context,e.periods[0]);
  if(stableAnalyticalJSON(promotion)!==stableAnalyticalJSON(e.promotion))mismatch();
  const rows=e.source_rows||[];for(const r of rows)if(r.date<context.start_date||r.date>context.end_date||!/^\d{4}-\d{2}-\d{2}$/.test(r.date))mismatch();
  const expected=e.retrieval_failed?[]:[{label:'Full period',...numericDistribution(rows,e.operation)},...(promotion.status==='confirmed'?[{label:'Sale-excluded comparison',...numericDistribution(rows.filter(r=>!promotion.dates.includes(r.date)),e.operation)}]:[])];
  if(stableAnalyticalJSON(expected)!==stableAnalyticalJSON(e.sections)||stableAnalyticalJSON(expected.flatMap(s=>s.scenarios.map(r=>({comparison:s.label,...r}))))!==stableAnalyticalJSON(e.rows))mismatch();
  if(stableAnalyticalJSON(candidatesFor(e.catalogue,e.sections,e.currency))!==stableAnalyticalJSON(e.candidates))mismatch();
  if(e.chart_datasets&&stableAnalyticalJSON(chartDatasets(e))!==stableAnalyticalJSON(e.chart_datasets))mismatch();
  if(e.chart_specs&&stableAnalyticalJSON(withOracleCharts({answer:'',evidence:{...e,chart_specs:undefined}}).charts)!==stableAnalyticalJSON(e.chart_specs))mismatch();
}
export async function answerOrderValues({context,provider,productPrices,knowledgeService,exportStore,exportOwner,requestId,onEvidence,onProviderStage,signal,deadlineAt,now=()=>new Date()}){
  const operation=validateNumericOperation(context.numeric_operation),period={start_date:context.start_date,end_date:context.end_date};
  const args={...period,platform:context.platform,source_store:context.source_store,channel:context.channel,time_zone:context.time_zone,country:context.geography,currency:context.currencies[0],basis:operation.basis,assumed_charge:operation.assumed_charge};
  const results=await Promise.allSettled([Promise.resolve().then(()=>{if(!provider)throw Error('Provider unavailable');return provider(args,{signal,deadlineAt,onProviderStage});}),boundedEvidenceRead(()=>context.promotion_context?retrievePromotionContext(knowledgeService,context.promotion_context,period):null,{signal,deadlineAt}),boundedEvidenceRead(()=>operation.enrich_products&&context.geography==='GB'&&productPrices?productPrices({signal,deadlineAt,onProviderStage}):null,{signal,deadlineAt})]);
  const data=results[0].status==='fulfilled'?results[0].value:null,limitations=[];
  if(data){const expected={...args,source_store:'shopify'};if(stableAnalyticalJSON(data.scope)!==stableAnalyticalJSON(expected))mismatch();}
  if(!data)limitations.push(`Population retrieval unavailable (${results[0].reason?.code||'ORDER_VALUE_RETRIEVAL_FAILED'}). Retry or narrow the period; no aggregate sales substitute was used.`);
  const promotion_source=results[1].status==='fulfilled'?results[1].value:null,promotion=resolvePromotionDates(promotion_source,context.promotion_context,period);
  if(!['confirmed','not_requested'].includes(promotion.status))limitations.push(promotion.clarification||'Promotion exclusions are unavailable. Full-period analysis is retained.');
  const source_rows=data?.rows||[],sections=data?[{label:'Full period',...numericDistribution(source_rows,operation)},...(promotion.status==='confirmed'?[{label:'Sale-excluded comparison',...numericDistribution(source_rows.filter(r=>!promotion.dates.includes(r.date)),operation)}]:[])]:[];
  const catalogue=results[2].status==='fulfilled'?results[2].value:null,candidates=candidatesFor(catalogue,sections,args.currency);
  if(operation.enrich_products&&!candidates.length)limitations.push('Current published UK price enrichment is unavailable or no verified price-compatible candidates bridge the observed gaps. No inventory was retrieved.');
  const analysis_context={...context,source_store:'shopify',...(context.promotion_context&&!['confirmed','not_requested'].includes(promotion.status)?{promotion_context:{...context.promotion_context,pending_dates:true,pending_endpoint_date:promotion.events.find(e=>e.interpretation?.endpoint_options)?.interpretation.established_end_date||null,pending_endpoint:promotion.status==='temporal_unresolved'&&Boolean(promotion.events.some(e=>e.interpretation?.endpoint_options))}}:{})};
  const evidence={kind:'governed_order_values',requested_subject:'order_values',metrics:['orders'],periods:[period],source_store:'shopify',country:args.country,currency:args.currency,time_zone:args.time_zone,basis:operation.basis,operation,definitions:ORDER_VALUE_DEFINITIONS,analytical_plan:resolveAnalyticalPlan(analysis_context),source_rows,sections,rows:sections.flatMap(s=>s.scenarios.map(r=>({comparison:s.label,...r}))),coverage:data?.coverage||{complete:false,population_complete:'unverified'},promotion_source,promotion,catalogue,candidates,limitations,retrieval_failed:!data,retrieval:results.map((r,i)=>({component:['population','promotion','published_prices'][i],status:r.status})),generated_at:new Date(now()).toISOString()};
  if(data?.coverage?.eligible_orders!=null&&Number(data.coverage.eligible_orders)!==sections[0].population)mismatch();
  evidence.chart_datasets=chartDatasets(evidence);
  assertOrderValueEvidence(analysis_context,evidence);
  let result=withOracleCharts({analysis_context,analysis_unavailable:!data,partial:Boolean(data&&(results.some(r=>r.status==='rejected')||data.coverage?.coverage_retrieval==='rejected')),answer:orderValueBusinessView(evidence).join('\n\n')+'\n\n'+JSON.stringify({definitions:evidence.definitions,coverage:evidence.coverage,promotion:evidence.promotion}),tools:['get_order_value_analysis'],evidence});
  onProviderStage?.({stage:'order_value_validation',status:data?'success':'unavailable',aggregate_groups:source_rows.length,synthesis_path:'validated_aggregate',model_calls:0});await onEvidence?.(result);
  if(context.output_preference==='xlsx'){
    if(!exportStore||!exportOwner||!requestId)return {...result,answer:result.answer+'\n\nExport storage is unavailable; retrieved figures are retained.'};
    const id=priorityArtifactId(exportOwner,requestId);
    try{
      const saved=await exportStore.get(id,exportOwner);if(saved){assertOrderValueEvidence(analysis_context,saved.envelope);if(createHash('sha256').update(Buffer.from(saved.xlsx_base64,'base64')).digest('hex')!==saved.sha256)mismatch();return withOracleCharts({...result,analysis_context:saved.analysis_context||analysis_context,answer:saved.answer,evidence:saved.envelope,artifact:{id,filename:saved.filename,row_count:saved.envelope.rows.length,download_url:`/api/oracle/exports/${id}`}});}
      const bytes=Buffer.from(await reportWorkbook({generated_at:evidence.generated_at,period,comparison:period,kpis:evidence.rows,trend:sections.flatMap(s=>s.bands.map(b=>({comparison:s.label,...b}))),products:candidates,context:sections.flatMap(s=>s.gaps.map(g=>({comparison:s.label,...g}))),limitations:[...limitations,JSON.stringify(ORDER_VALUE_DEFINITIONS),JSON.stringify(evidence.coverage),JSON.stringify(promotion),JSON.stringify(evidence.analytical_plan)]}));
      const filename='oracle-order-value-scenarios.xlsx';await exportStore.put(id,exportOwner,{answer:result.answer,analysis_context,envelope:result.evidence,filename,sha256:createHash('sha256').update(bytes).digest('hex'),xlsx_base64:bytes.toString('base64')});result={...result,artifact:{id,filename,row_count:evidence.rows.length,download_url:`/api/oracle/exports/${id}`}};await onEvidence?.(result);
    }catch(error){if(error.code==='EVIDENCE_SCOPE_MISMATCH')throw error;result.answer+='\n\nExport persistence failed; analysis is retained. Retry the export explicitly.';}
  }
  return result;
}

import { answerOrderValues, assertOrderValueEvidence, orderValueWorkbookTables, orderValueBusinessView } from './order-value-analysis.js';
import { BASKET_LINE_BOUND, BASKET_ORDER_BOUND, BASKET_LINE_COLUMNS } from './basket-provider.js';
import { stableAnalyticalJSON, resolveAnalyticalPlan, assertPlanAgreement } from './analytical-plan.js';
import { resolvePromotionDates, retrievePromotionContext } from './promotion-context.js';
import { safeReadFailure } from './read-failure.js';
import { boundedEvidenceRead } from './bounded-evidence-read.js';
import { reportWorkbook } from './report-export.js';
import { priorityArtifactId } from './product-priority-storage.js';
import { withOracleCharts } from './evidence-charts.js';
import { createHash, createHmac, randomBytes } from 'node:crypto';

// Exact decimal parsing: no floating point rounding across threshold boundaries.
export function basketMinor(value){
  if(value==null)return null;
  const m=String(value).match(/^(\d+)(?:\.(\d{1,2})0*)?$/);if(!m)return null;
  const n=Number(m[1])*100+Number((m[2]||'').padEnd(2,'0'));return Number.isSafeInteger(n)?n:null;
}
const fail=()=>{throw Object.assign(Error('Basket evidence differs from the validated operation or scope'),{code:'EVIDENCE_SCOPE_MISMATCH'});};
export const BASKET_DEFINITIONS=Object.freeze({
  identity:'Shopify/shopify/order; latest order component and order/line snapshots before joins. Product ID is the root Shopify product identity; variants remain the same product.',
  quantity:'Original purchased units, not current units. Partially refunded orders excluded: refund allocation to individual units is unverified. Line count and distinct root products are separate.',
  discounts:'Original line total must equal original unit price × quantity; allocated presentment discounts must sum to total line discount and reconcile to discounted line total. Equal allocation across identical units is used only when the discounted line total divides exactly into pennies; otherwise excluded. Empty allocations support zero discount only when all monetary equalities hold. Ambiguous stored zero prices are excluded.',
  reconciliation:'Sum of supported discounted line totals must equal the observed original discounted order merchandise subtotal exactly. Unsupported lines exclude the whole basket. Gift cards, custom/missing product identities, missing lines, partial refunds and unsupported money/quantities are counted explicitly.',
  vat:'Observed discounted presentment merchandise basis; shipping excluded. Tax inclusion and actual shipping-rule VAT basis are unverified. Threshold comparisons are conditional on this observed basis, not verified policy eligibility.',
  main_item:'Chosen highest allocated discounted individual unit. Ties: product ID, then line ID ascending. Remaining units include other units of the main product. No purchase-intent claim.',
  population:'Shopify collected history only; direct shipping destinations and presentment currency. Existing retail_location_id IS NULL online proxy, not positive Online Store attribution. Matrixify, cancelled, unpaid and fully refunded excluded by governed order population.',
  coverage:'Requested end date, latest observed eligible date and collection timestamps are separate; collection completeness remains unverified. No freshness conclusion follows from advancing requested dates.',
  inference:'Basket composition does not establish which item was added last, motivation to unlock shipping, or behaviour under a different threshold.'
});
function inspectBasket(order,currency){
  if(order.currency!==currency)return {reason:'currency_mismatch'};
  if(order.display_financial_status==='partially_refunded')return {reason:'partial_refund'};
  const lines=order.lines||[];
  if(!lines.length||Number(order.line_count)!==lines.length)return {reason:'missing_or_incomplete_lines'};
  if(lines.length>BASKET_LINE_BOUND)return {reason:'line_bound'};
  const seen=new Set(),items=[];let sum=0,quantity=0;
  for(const l of lines){
    if(!l.line_item_id||seen.has(l.line_item_id))return {reason:'duplicate_or_missing_line_identity'};
    seen.add(l.line_item_id);
    if(!/^gid:\/\/shopify\/Product\/\d+$/.test(l.product_id||''))return {reason:'custom_or_missing_product_identity'};
    if(l.is_gift_card!==false)return {reason:'gift_card_or_unknown'};
    const q=Number(l.quantity);
    if(!Number.isSafeInteger(q)||q<1||q>10000||Number(l.current_quantity)!==q)return {reason:'unsupported_quantity_or_changed_units'};
    if(l.presentment_currency!==currency)return {reason:'line_currency_mismatch'};
    const original=basketMinor(l.original_total_presentment),unit=basketMinor(l.original_unit_price_presentment),discount=basketMinor(l.total_discount_presentment),total=basketMinor(l.discounted_total_presentment);
    if([original,unit,discount,total].some(v=>v==null)||!unit||!total)return {reason:'unknown_money_or_ambiguous_zero'};
    let allocations;
    try{allocations=JSON.parse(l.discount_allocations_json);}catch{return {reason:'unknown_discount_allocation'};}
    if(!Array.isArray(allocations))return {reason:'unknown_discount_allocation'};
    const allocated=allocations.map(a=>a.allocatedAmountSet?.presentmentMoney).map(m=>m?.currencyCode===currency?basketMinor(m.amount):null);
    if(allocated.some(v=>v==null)||allocated.reduce((a,b)=>a+b,0)!==discount||original!==unit*q||original-discount!==total)return {reason:'discount_reconciliation_failed'};
    if(total%q)return {reason:'nonuniform_unit_allocation'};
    sum+=total;quantity+=q;
    if(!Number.isSafeInteger(sum)||!Number.isSafeInteger(quantity))return {reason:'precision_bound'};
    items.push({product_id:l.product_id,line_item_id:l.line_item_id,title:String(l.title||'Unnamed product').replace(/[<>|\r\n]/g,' ').slice(0,160),quantity:q,unit_minor:total/q,total_minor:total});
  }
  if(sum!==basketMinor(order.merchandise_amount))return {reason:'order_reconciliation_failed'};
  items.sort((a,b)=>b.unit_minor-a.unit_minor||a.product_id.localeCompare(b.product_id)||a.line_item_id.localeCompare(b.line_item_id));
  const main=items[0],remaining=items.map((i,index)=>({...i,quantity:i.quantity-(index===0?1:0)})).filter(i=>i.quantity);
  return {value:{date:order.date,total_minor:sum,quantity,line_count:lines.length,distinct_products:new Set(items.map(i=>i.product_id)).size,main,remaining,remaining_minor:sum-main.unit_minor,remaining_quantity:quantity-1}};
}
export function basketComposition(rows,thresholds,currency,detail=null,legacy=false){
  const excluded={},valid=[],identities=new Set();
  for(const r of rows){if(!r.order_id||identities.has(r.order_id))fail();identities.add(r.order_id);const result=inspectBasket(r,currency);if(result.reason)excluded[result.reason]=(excluded[result.reason]||0)+1;else valid.push(result.value);}
  const subset=detail?.subset||{highest_below:25000,total_at_least:25000};
  const qualifying=valid.filter(b=>b.main.unit_minor<subset.highest_below&&b.total_minor>=subset.total_at_least);
  const comparisonPopulation=detail?.comparison_scope==='subset'?qualifying:valid;
  const comparisons=thresholds.map(threshold=>{
    const t=basketMinor(threshold);if(t==null)fail();
    const needed=comparisonPopulation.filter(b=>b.main.unit_minor<t&&b.total_minor>=t);
    return {threshold,additional_items_required:needed.length,highest_unit_already_qualifies:comparisonPopulation.filter(b=>b.main.unit_minor>=t).length,mixed_products:needed.filter(b=>b.distinct_products>1).length,repeated_single_product:needed.filter(b=>b.distinct_products===1).length,one_expensive_unit_plus_cheaper:needed.filter(b=>b.remaining.every(i=>i.unit_minor<b.main.unit_minor)).length,tied_highest_units:needed.filter(b=>b.remaining.some(i=>i.unit_minor===b.main.unit_minor)).length};
  });

  const bands=(detail?.bands?.map(b=>[b.lower,b.upper])||[[25000,27500],[27500,30000],[30000,null]]).map(([lower,upper])=>({lower:lower/100,upper:upper==null?null:upper/100,orders:qualifying.filter(b=>b.total_minor>=lower&&(upper==null||b.total_minor<upper)).length}));
  const combinations=new Map(),smaller=new Map();
  for(const b of qualifying){
    // Aggregate identical product/actual price/quantity combinations, never IDs.
    const rest=new Map();for(const i of b.remaining){const key=i.product_id+':'+i.unit_minor;const old=rest.get(key);rest.set(key,{product_id:i.product_id,title:i.title,unit_price:i.unit_minor/100,quantity:(old?.quantity||0)+i.quantity});}
    const remaining=[...rest.values()].sort((a,b)=>a.product_id.localeCompare(b.product_id)||a.unit_price-b.unit_price);
    const example={main_product:b.main.title,main_product_id:b.main.product_id,main_unit_price:b.main.unit_minor/100,remaining,remaining_value:b.remaining_minor/100,remaining_quantity:b.remaining_quantity,basket_value:b.total_minor/100,above_250:(b.total_minor-25000)/100,above_threshold:(b.total_minor-subset.total_at_least)/100,distinct_products:b.distinct_products};
    const {above_threshold,...legacyExample}=example;
    const key=legacy?stableAnalyticalJSON(legacyExample):stableAnalyticalJSON({main_product_id:example.main_product_id,main_unit_price:example.main_unit_price,remaining:remaining.map(({product_id,unit_price,quantity})=>({product_id,unit_price,quantity}))});combinations.set(key,{...example,orders:(combinations.get(key)?.orders||0)+1});
    const counted=new Set();for(const i of b.remaining.filter(i=>i.unit_minor<b.main.unit_minor)){const key=i.product_id+':'+i.unit_minor,old=smaller.get(key)||{product_id:i.product_id,title:i.title,unit_price:i.unit_minor/100,orders:0,units:0};old.units+=i.quantity;if(!counted.has(key)){old.orders++;counted.add(key);}smaller.set(key,old);}
  }
  return {subset_orders:qualifying.length,overlap_orders:detail?.overlap?qualifying.filter(b=>b.main.unit_minor>=detail.overlap.lower&&b.main.unit_minor<detail.overlap.upper).length:null,subset_mixed_products:qualifying.filter(b=>b.distinct_products>1).length,subset_repeated_product:qualifying.filter(b=>b.distinct_products===1).length,population:rows.length,reconciled_orders:valid.length,excluded_orders:rows.length-valid.length,excluded,single_unit_orders:valid.filter(b=>b.quantity===1).length,multi_unit_orders:valid.filter(b=>b.quantity>1).length,single_product_orders:valid.filter(b=>b.distinct_products===1).length,mixed_product_orders:valid.filter(b=>b.distinct_products>1).length,line_count:valid.reduce((n,b)=>n+b.line_count,0),unit_count:valid.reduce((n,b)=>n+b.quantity,0),comparisons,bands,combinations:[...combinations.values()].sort((a,b)=>b.orders-a.orders||stableAnalyticalJSON(a).localeCompare(stableAnalyticalJSON(b))).slice(0,detail?.limit||20),smaller_products:[...smaller.values()].sort((a,b)=>b.orders-a.orders||a.product_id.localeCompare(b.product_id)).slice(0,detail?.limit||20)};
}
const money=(n,c)=>`${c} ${Number(n).toFixed(2)}`;
export function basketBusinessView(e){
  if(e.retrieval_failed)return [...(e.order_result?orderValueBusinessView(e.order_result.evidence):[]),'Basket composition evidence is unavailable; no basket counts or product combinations were calculated.'];
  const s=e.sections[0];if(e.detail?.comparison_scope==='subset'&&e.detail.level==='aggregate')return selectedSections(e).flatMap(s=>[`${s.label}: aggregate comparison of the same ${s.subset_orders} selected reconciled baskets.`,['| Threshold | Additional items required | Highest unit already qualifies |','|---|---:|---:|',...s.comparisons.map(r=>`| ${money(r.threshold,e.currency)} | ${r.additional_items_required} | ${r.highest_unit_already_qualifies} |`)].join('\n')]);
  if(e.detail?.level==='underlying')return ['Underlying reconciled baskets: anonymous merchandise and product rows are prepared for the XLSX export. Reconciliation exclusions and coverage remain in Show details.'];
  if(e.detail?.level==='detail'){const sections=e.detail.subset?.exclude_sale?e.sections.filter(s=>s.label==='Exclusion comparison'):e.sections;if(!sections.length)return ['The requested sale-excluded subset is unavailable because its exclusion dates are unresolved. Full-period evidence is retained in Show details.'];return sections.flatMap(s=>[`${s.label}: ${s.subset_orders} reconciled baskets match the requested highest-unit and merchandise-total predicates. ${s.subset_mixed_products} contain different products; ${s.subset_repeated_product} repeat one product.`,...(s.overlap_orders==null?[]:[`${s.overlap_orders} have a highest unit in the requested lower-threshold interval.`]),['| Basket total (lower inclusive, upper exclusive) | Orders |','|---|---:|',...s.bands.map(b=>`| ${money(b.lower,e.currency)} to ${b.upper==null?'+':money(b.upper,e.currency)} | ${b.orders} |`)].join('\n'),['| Highest product / discounted unit price | Remaining products / discounted unit prices | Orders | Remaining value |','|---|---|---:|---:|',...s.combinations.map(b=>`| ${b.main_product} / ${money(b.main_unit_price,e.currency)} | ${b.remaining.map(i=>`${i.quantity} × ${i.title} / ${money(i.unit_price,e.currency)}`).join('; ')} | ${b.orders} | ${money(b.remaining_value,e.currency)} |`)].join('\n')]);}
  return [...(e.order_result?['Order-level sections use all retrieved eligible orders; basket sections use only reconciled baskets. Their denominators differ.',...orderValueBusinessView(e.order_result.evidence)]:[]),`${s.reconciled_orders} of ${s.population} retrieved orders have reconciled basket evidence: ${s.single_unit_orders} single-unit and ${s.multi_unit_orders} multi-unit orders. ${s.excluded_orders} orders were excluded. These observations establish composition, not buying intent.`,...e.sections.map(s=>s.label+'\n\n'+['| Threshold | Additional items required | Highest unit already qualifies | Mixed products requiring items | Repeated same product requiring units |','|---:|---:|---:|---:|---:|',...s.comparisons.map(r=>`| ${money(r.threshold,e.currency)} | ${r.additional_items_required} | ${r.highest_unit_already_qualifies} | ${r.mixed_products} | ${r.repeated_single_product} |`)].join('\n')),'Shopify collected history only; online eligibility uses a proxy. VAT inclusion and shipping-rule basis are unverified; comparisons use observed discounted merchandise. Collection completeness is unverified.'];
}
export function basketDetails(e){return `Requested end date: ${e.scope.end_date}. Latest observed eligible order date: ${e.coverage.latest_observed_order_date||'unavailable'}. Verified collection coverage: unavailable.\n\n`+e.sections.flatMap(s=>[s.label,`Up to ${e.detail?.limit||20} most common combinations and smaller product/price groups are shown; examples are anonymous observed combinations.`, ['| Threshold | One highest unit plus strictly cheaper units | Tied highest units |','|---|---:|---:|',...s.comparisons.map(r=>`| ${money(r.threshold,e.currency)} | ${r.one_expensive_unit_plus_cheaper} | ${r.tied_highest_units} |`)].join('\n'),`Coverage: ${s.reconciled_orders}/${s.population} reconciled; single-unit ${s.single_unit_orders}, multi-unit ${s.multi_unit_orders}; single-product ${s.single_product_orders}, mixed-product ${s.mixed_product_orders}; ${s.line_count} lines, ${s.unit_count} units. Excluded: ${JSON.stringify(s.excluded)}.`,['| Qualifying basket total band | Orders |','|---|---:|',...s.bands.map(b=>`| ${money(b.lower,e.currency)}–${b.upper==null?'+':money(b.upper-0.01,e.currency)} | ${b.orders} |`)].join('\n'),['| Main product at actual allocated price | Remaining products at actual allocated prices | Orders | Remaining value | Basket value | Above selected minimum |','|---|---|---:|---:|---:|---:|',...s.combinations.map(b=>`| ${b.main_product} (${money(b.main_unit_price,e.currency)}) | ${b.remaining.map(i=>`${i.quantity} × ${i.title} (${money(i.unit_price,e.currency)})`).join('; ')} | ${b.orders} | ${money(b.remaining_value,e.currency)} | ${money(b.basket_value,e.currency)} | ${money(b.above_threshold,e.currency)} |`)].join('\n'),['| Smaller remaining product | Allocated unit price | Orders | Units |','|---|---:|---:|---:|',...s.smaller_products.map(p=>`| ${p.title} | ${money(p.unit_price,e.currency)} | ${p.orders} | ${p.units} |`)].join('\n')]).join('\n\n');}
function sectionsFor(rows,context,promotion,legacy=false){return [{label:'Full period',...basketComposition(rows,context.numeric_operation.thresholds,context.currencies[0],context.request_detail,legacy)},...(promotion.status==='confirmed'?[{label:'Exclusion comparison',...basketComposition(rows.filter(r=>!promotion.dates.includes(r.date)),context.numeric_operation.thresholds,context.currencies[0],context.request_detail,legacy)}]:[])];}
function selectedSections(e){return e.detail?.subset?.exclude_sale&&e.detail.level!=='underlying'?e.sections.filter(s=>s.label==='Exclusion comparison'):e.sections;}
function basketOutputRows(e){return e.detail?.level==='detail'?selectedSections(e).flatMap(s=>s.bands.map(b=>({comparison:s.label,...b,subset_orders:s.subset_orders,highest_unit_interval_orders:s.overlap_orders}))):e.sections.flatMap(s=>s.comparisons.map(r=>({comparison:s.label,...r})));}
export function basketWorkbookTables(e){return [...(e.order_result?[...orderValueWorkbookTables(e.order_result.evidence).map(([n,r])=>['Order '+n,r]),['Order scenarios',e.order_result.evidence.rows],['Order bands',e.order_result.evidence.sections.flatMap(s=>s.bands.map(b=>({comparison:s.label,...b})))]]:[]),...(e.anonymous_rows?[['Anonymous baskets',e.anonymous_rows]]:[]),['Basket coverage',selectedSections(e).map(({comparisons,bands,combinations,smaller_products,...s})=>({...s,excluded:JSON.stringify(s.excluded)}))],['Combinations',selectedSections(e).flatMap(s=>s.combinations.map(b=>({...b,comparison:s.label,remaining:JSON.stringify(b.remaining)})))],['Smaller products',selectedSections(e).flatMap(s=>s.smaller_products.map(p=>({...p,comparison:s.label})))],['Basket bands',selectedSections(e).flatMap(s=>s.bands.map(b=>({...b,comparison:s.label})))]];}
function basketComponents(context,e){return context.requested_operations.map(operation=>operation==='basket_composition'?{operation,status:e.retrieval_failed?'failed':'supported',detail:'Reconciled line evidence only.'}:e.order_result?.evidence.components.find(c=>c.operation===operation)||{operation,status:'unavailable',detail:'This additional component is unavailable in the basket binding; compatible composition evidence is retained.'});}
export function assertBasketEvidence(context,e){
  assertPlanAgreement(context,e);
  if(e.kind!=='governed_basket_composition'||!context.requested_operations.includes('basket_composition')||e.currency!==context.currencies[0]||e.country!==context.geography||stableAnalyticalJSON(e.definitions)!==stableAnalyticalJSON(BASKET_DEFINITIONS))fail();
  if(e.order_result){const expected={...context,requested_operations:context.requested_operations.filter(o=>o!=='basket_composition'),request_detail:null,output_preference:null,dimensions:['numeric_band']};assertOrderValueEvidence(expected,e.order_result.evidence);}
  if(stableAnalyticalJSON(e.components)!==stableAnalyticalJSON(basketComponents(context,e)))fail();
  if(!e.analytical_plan||stableAnalyticalJSON(e.periods)!==stableAnalyticalJSON([{start_date:context.start_date,end_date:context.end_date}]))fail();
  if(stableAnalyticalJSON(e.scope)!==stableAnalyticalJSON(basketArgs(context)))fail();
  for(const r of e.source_rows||[])if(!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||r.date<context.start_date||r.date>context.end_date)fail();
  const promotion=resolvePromotionDates(e.promotion_source,context.promotion_context,{start_date:context.start_date,end_date:context.end_date});
  let expected=e.retrieval_failed?[]:sectionsFor(e.source_rows,context,promotion,!Object.hasOwn(e,'detail'));
  if(!Object.hasOwn(e,'detail'))expected=expected.map(({subset_orders,overlap_orders,subset_mixed_products,subset_repeated_product,...s})=>({...s,combinations:s.combinations.map(({above_threshold,...b})=>b)}));
  if(stableAnalyticalJSON(promotion)!==stableAnalyticalJSON(e.promotion)||stableAnalyticalJSON(expected)!==stableAnalyticalJSON(e.sections))fail();
  if(stableAnalyticalJSON(e.detail||null)!==stableAnalyticalJSON(context.request_detail||null))fail();
  if(e.source_rows.length>BASKET_ORDER_BOUND||e.detail?.level==='underlying'&&!e.retrieval_failed&&!Array.isArray(e.anonymous_rows))fail();
  if(e.anonymous_rows&&stableAnalyticalJSON(e.anonymous_rows)!==stableAnalyticalJSON(anonymousBasketRows(e)))fail();
  if(e.chart_datasets&&stableAnalyticalJSON(e.chart_datasets)!==stableAnalyticalJSON(basketChartDatasets(e)))fail();
  if(e.chart_specs&&stableAnalyticalJSON(e.chart_specs)!==stableAnalyticalJSON(withOracleCharts({answer:'',evidence:{...e,chart_specs:undefined}}).charts))fail();
  if(stableAnalyticalJSON(e.rows)!==stableAnalyticalJSON(basketOutputRows(e)))fail();
}
function basketArgs(c){return {start_date:c.start_date,end_date:c.end_date,platform:'shopify',source_store:'shopify',channel:'online',time_zone:c.time_zone,country:c.geography,currency:c.currencies[0],basis:'observed_subtotal',assumed_charge:8};}
export async function answerBasketComposition({context,provider,orderProvider,downloadBase='/api/oracle/exports',knowledgeService,exportStore,exportOwner,requestId,onEvidence,onProviderStage,signal,deadlineAt,now=()=>new Date()}){
  const scope=basketArgs(context),analysis_context={...context,source_store:'shopify'};
  if(exportStore&&exportOwner&&requestId&&(context.output_preference==='xlsx'||context.request_detail?.formats.includes('xlsx'))){
    const id=priorityArtifactId(exportOwner,requestId);let saved=null;try{saved=await exportStore.get(id,exportOwner);}catch{}
    if(saved){assertBasketEvidence(analysis_context,saved.envelope);const {assertProductArtifact}=await import('./product-artifact-validation.js');await assertProductArtifact(saved);return withOracleCharts({answer:saved.answer,analysis_context:saved.analysis_context,evidence:saved.envelope,tools:['get_order_value_analysis'],analysis_unavailable:saved.envelope.retrieval_failed||!saved.envelope.sections[0]?.reconciled_orders,partial:Boolean(saved.envelope.sections.some(s=>s.excluded_orders)),export_outcome:{status:'delivered'},artifact:{id,filename:saved.filename,row_count:saved.envelope.anonymous_rows?.length??saved.envelope.rows.length,download_url:`${downloadBase}/${id}`}});}
  }
  const results=await Promise.allSettled([boundedEvidenceRead(()=>{if(!provider)throw Object.assign(Error('Basket provider unavailable'),{code:'BASKET_PROVIDER_UNAVAILABLE'});return provider(scope,{signal,deadlineAt,onProviderStage});},{signal,deadlineAt}),boundedEvidenceRead(()=>context.promotion_context&&knowledgeService?retrievePromotionContext(knowledgeService,context.promotion_context,scope):null,{signal,deadlineAt})]);
  const data=results[0].status==='fulfilled'?results[0].value:null;
  if(data&&stableAnalyticalJSON(data.scope)!==stableAnalyticalJSON(scope))fail();
  const promotion_source=results[1].status==='fulfilled'?results[1].value:null,promotion=resolvePromotionDates(promotion_source,context.promotion_context,scope);
  const e={detail:context.request_detail||null,export_scope:randomBytes(32).toString('hex'),kind:'governed_basket_composition',requested_subject:'order_values',scope,currency:scope.currency,country:scope.country,periods:[{start_date:scope.start_date,end_date:scope.end_date}],analytical_plan:resolveAnalyticalPlan(analysis_context),definitions:BASKET_DEFINITIONS,components:context.requested_operations.map(operation=>({operation,status:operation==='basket_composition'?(data?'supported':'failed'):'unavailable',detail:operation==='basket_composition'?'Reconciled line evidence only.':'This additional component is unavailable in the basket binding; compatible composition evidence is retained.'})),source_rows:privateBasketRows(data?.rows||[]),sections:data?sectionsFor(data.rows,context,promotion):[],promotion,promotion_source,coverage:{...data?.coverage,requested_end_date:scope.end_date,latest_observed_order_date:data?.rows?.reduce((m,r)=>r.date>m?r.date:m,'')||null,verified_collection_coverage:false},retrieval_failed:!data,failure:results[0].status==='rejected'?safeReadFailure(results[0].reason,'basket_population'):null,retrieval:results.map((r,i)=>({component:i?'promotion':'basket_population',status:r.status,...(r.status==='rejected'?{failure:safeReadFailure(r.reason,i?'promotion':'basket_population')}: {})})),generated_at:new Date(now()).toISOString()};
  if(context.request_detail?.level==='underlying'&&data)e.anonymous_rows=anonymousBasketRows(e);
  e.rows=basketOutputRows(e);assertBasketEvidence(analysis_context,e);
  await onEvidence?.({answer:[...basketBusinessView(e),basketDetails(e)].join('\n\n'),analysis_context,evidence:structuredClone(e),tools:['get_order_value_analysis'],partial:true,analysis_unavailable:!data});
  if(context.requested_operations.some(o=>o!=='basket_composition')&&orderProvider){const orderContext={...analysis_context,requested_operations:context.requested_operations.filter(o=>o!=='basket_composition'),request_detail:null,output_preference:null,dimensions:['numeric_band']};const orderResult=await answerOrderValues({context:orderContext,provider:orderProvider,knowledgeService,signal,deadlineAt,now});e.order_result={evidence:orderResult.evidence};}
  e.components=basketComponents(context,e);
  if(context.request_detail?.level==='underlying'&&data)e.anonymous_rows=anonymousBasketRows(e);
  e.rows=basketOutputRows(e);assertBasketEvidence(analysis_context,e);
  let result=withOracleCharts({answer:[...basketBusinessView(e),basketDetails(e),...Object.values(BASKET_DEFINITIONS),...e.components.filter(c=>c.operation!=='basket_composition').map(c=>`${c.operation}: ${c.status}. ${c.detail}`),context.promotion_context&&promotion.status!=='confirmed'?'Requested exclusion comparison is unavailable; full-period evidence is retained.':null].filter(Boolean).join('\n\n'),analysis_context,evidence:e,tools:['get_order_value_analysis'],analysis_unavailable:!data||!e.sections[0]?.reconciled_orders,partial:!data||e.components.some(c=>['unavailable','failed'].includes(c.status))||Boolean(context.promotion_context&&promotion.status!=='confirmed')||Boolean(e.sections[0]?.excluded_orders)||results.some(r=>r.status==='rejected')||data?.coverage?.coverage_retrieval==='rejected'});
  if(context.request_detail?.formats.includes('chart')&&!e.retrieval_failed){e.chart_datasets=basketChartDatasets(e);result=withOracleCharts({...result,evidence:e});}
  await onEvidence?.(result);
  if(context.output_preference==='xlsx'||context.request_detail?.formats.includes('xlsx')){
    if(!data)return {...result,partial:true,export_outcome:{status:'failed',detail:'Basket retrieval failed; no workbook created.'}};
    if(!exportStore||!exportOwner||!requestId)return {...result,partial:true,export_outcome:{status:'failed',detail:'Export storage is unavailable.'},answer:result.answer+'\n\nExport storage is unavailable; analysis is retained.'};
    const id=priorityArtifactId(exportOwner,requestId),filename='oracle-basket-composition.xlsx';
    try{
      const saved=await exportStore.get(id,exportOwner);
      if(saved){assertBasketEvidence(analysis_context,saved.envelope);const {assertProductArtifact}=await import('./product-artifact-validation.js');await assertProductArtifact(saved);result={...result,evidence:saved.envelope,answer:saved.answer,analysis_context:saved.analysis_context};}
      else {const bytes=Buffer.from(await reportWorkbook({generated_at:e.generated_at,period:e.periods[0],comparison:e.periods[0],kpis:e.rows,additional_sheets:basketWorkbookTables(e),limitations:[...Object.values(BASKET_DEFINITIONS),JSON.stringify(e.coverage)]}));await exportStore.put(id,exportOwner,{answer:result.answer,analysis_context,envelope:e,filename,xlsx_base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')});}
      result={...result,export_outcome:{status:'delivered'},artifact:{id,filename,row_count:result.evidence.anonymous_rows?.length??result.evidence.rows.length,download_url:`${downloadBase}/${id}`}};await onEvidence?.(result);
    }catch(error){if(error.code==='EVIDENCE_SCOPE_MISMATCH')throw error;result.partial=true;result.export_outcome={status:'failed',code:error.code==='EXPORT_STORAGE_SIZE_EXCEEDED'?error.code:'EXPORT_PERSISTENCE_FAILED',detail:error.code==='EXPORT_STORAGE_SIZE_EXCEEDED'?'Export persistence failed: workbook and evidence exceed the 8 MB durable-storage limit. No rows were truncated. Narrow the date range or request the aggregate supporting tables. Analysis is retained.':'Export persistence failed; analysis is retained.'};result.answer+='\n\n'+result.export_outcome.detail;}
  }
  return result;
}

// Export-only opaque references cannot be joined across exports. No order/customer
// identifiers, admin URLs or private line properties enter these allowlisted rows.
export function anonymousBasketRows(e){
  if(!/^[a-f0-9]{64}$/.test(e.export_scope||''))fail();
  return e.source_rows.flatMap(r=>{const inspected=inspectBasket(r,e.currency);if(!inspected.value)return [];const b=inspected.value;return [{basket_reference:createHmac('sha256',e.export_scope).update(r.order_id).digest('hex').slice(0,32),sale_excluded:e.promotion.status==='confirmed'?e.promotion.dates.includes(r.date):e.promotion.status==='not_requested'?false:null,merchandise_subtotal:b.total_minor/100,highest_product:b.main.title,highest_discounted_unit_price:b.main.unit_minor/100,remaining_products:JSON.stringify(b.remaining.map(i=>({product:i.title,quantity:i.quantity,discounted_unit_price:i.unit_minor/100}))),remaining_quantity:b.remaining_quantity,remaining_discounted_value:b.remaining_minor/100}];});
}

function basketChartDatasets(e){return selectedSections(e).map((s,i)=>({id:`basket-bands-${i}`,shape:'ranking',title:s.label+' qualifying basket bands',metric:'orders',unit:'count',definition:'Reconciled baskets satisfying highest-unit and total predicates; lower inclusive, upper exclusive.',source:'Reconciled Shopify lines',population:`${s.subset_orders} qualifying / ${s.reconciled_orders} reconciled / ${s.population} retrieved`,period:`${e.scope.start_date} to ${e.scope.end_date}`,points:s.bands.map(b=>({label:`${b.lower}–${b.upper??'+'}`,value:b.orders}))}));}

// Internal calculation proof keeps source-qualified uniqueness without exposing
// raw order IDs through polling/manifests. The random HMAC key is never saved.
function privateBasketRows(rows){
  const key=randomBytes(32),columns=Object.keys(BASKET_LINE_COLUMNS).filter(k=>!['order_id','synced_at'].includes(k));
  return rows.map(r=>({order_id:r.order_id?createHmac('sha256',key).update(r.order_id).digest('hex'):null,date:r.date,currency:r.currency,display_financial_status:r.display_financial_status,line_count:r.line_count,merchandise_amount:r.merchandise_amount,lines:(r.lines||[]).map(l=>Object.fromEntries(columns.map(k=>[k,l[k]])))}));
}

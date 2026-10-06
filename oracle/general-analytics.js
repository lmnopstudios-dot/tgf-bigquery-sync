import {financeSource,financeComponents,migrationDiagnostics,ONLINE_COMPARISON_BOUNDARY,isOnline} from './sales-comparison.js';
import { normalizeProductTitle } from './ecommerce-report-v2.js';

const finite=value=>Number.isFinite(Number(value))?Number(value):null;
const esc=value=>String(value??'').replaceAll('|','\\|').replaceAll('\n',' ');
const money=(value,currency)=>value==null?'Unavailable':`${currency} ${Number(value).toLocaleString('en-GB',{maximumFractionDigits:2})}`;
const month=value=>String(value?.period||value?.date||'').slice(0,7);
const MONTH_NAMES=['','january','february','march','april','may','june','july','august','september','october','november','december'];
const sourceLabel=row=>{const source=financeSource(row);return /woo/i.test(source)?`${source.toLowerCase()==='woo'?'WooCommerce':source} online`:/square/i.test(source)?`${source.toLowerCase()==='square'?'Square':source} in-store`:/shopify/i.test(source)?`Shopify ${isOnline(row)?'online':'POS'}`:`${source} ${row.channel||''}`.trim();};
const chart=(id,title,period,metric,rows,{percent=false}={})=>({version:1,kind:'line',id,title,period,metric,source:'Governed persisted commerce evidence',series:rows,percent,missing_values:'gap',placement:null});

const sourceRef=row=>row.source_product_ref||([row.source_platform,row.source_store,row.source_product_id].every(Boolean)?`${row.source_platform}:${row.source_store}:${row.source_product_id}`:null);
function productChoices(matches){
  const grouped=new Map();
  for(const row of matches){
    if(!row.product_ref)continue;
    const choice=grouped.get(row.product_ref)||{product_ref:row.product_ref,titles:new Set(),sources:new Map(),relationships:new Set()};
    for(const title of [row.canonical_title,row.source_title])if(title)choice.titles.add(String(title));
    const ref=sourceRef(row);
    if(ref)choice.sources.set(ref,{source_platform:row.source_platform||null,source_store:row.source_store||null,source_product_ref:ref});
    if(row.mapping_method||row.mapping_status)choice.relationships.add([row.mapping_method,row.mapping_status].filter(Boolean).join(' · '));
    grouped.set(row.product_ref,choice);
  }
  return [...grouped.values()].map(choice=>({product_ref:choice.product_ref,catalogue_titles:[...choice.titles],sources:[...choice.sources.values()],reporting_family_relationships:[...choice.relationships]}));
}
function choiceList(entity,choices){
  const lines=[`**${esc(entity)}** is ambiguous across ${choices.length} governed product identities. Please choose one; I have not combined them.`];
  choices.forEach((choice,index)=>{
    const titles=choice.catalogue_titles.length?choice.catalogue_titles.map(esc).join(' / '):'Title unavailable';
    const sources=choice.sources.length?choice.sources.map(source=>`${esc(source.source_platform||'Unknown platform')} / ${esc(source.source_store||'Unknown store')} — \`${esc(source.source_product_ref)}\``).join('; '):'Source identity unavailable';
    const family=choice.reporting_family_relationships.length?choice.reporting_family_relationships.map(esc).join('; '):'No governed mapping relationship recorded in this evidence';
    lines.push(`${index+1}. **${titles}**\n   - Governed reporting identity: \`${esc(choice.product_ref)}\`\n   - Source platform / store and reference: ${sources}\n   - Mapping provenance (does not merge or rewrite source identities): ${family}`);
  });
  lines.push('Reply with the choice number or an exact stable product/source reference. I will validate it against only these offered candidates, then run the original sales request with its dates, channel and currency scope unchanged.');
  return lines.join('\n');
}
function requestedChoice(message,choices){
  const text=String(message||'').trim();
  const ordinalWords={first:1,second:2,third:3,fourth:4,fifth:5,sixth:6,seventh:7,eighth:8};
  const number=text.match(/^(?:(?:use|choose|pick|select)\s+)?(?:(?:the\s+)?(?:choice|option|candidate|one|number)\s*)?#?(\d+)\s*(?:one)?\s*[.!]?$/i);
  const ordinal=text.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth)\b/i);
  const index=number?Number(number[1]):ordinal?ordinalWords[ordinal[1].toLowerCase()]:null;
  if(index!=null)return {attempted:true,choice:choices[index-1]||null,selection_kind:number?'number':'ordinal'};
  const exact=choices.find(choice=>choice.product_ref===text||choice.sources.some(source=>source.source_product_ref===text));
  if(exact)return {attempted:true,choice:exact,selection_kind:exact.product_ref===text?'governed_reference':'source_reference'};
  const looksLikeSelection=/^(?:use|choose|pick|select)?\s*(?:the\s+)?(?:choice|option|number|#|first|second|third)\b/i.test(text)||/^(?:canonical|family|source|woo|shopify|square):\S+$/i.test(text);
  return {attempted:looksLikeSelection,choice:null,selection_kind:null};
}

function aggregate(rows,valueField='net_gross'){
  const groups=new Map();
  for(const row of rows||[]){const period=month(row),currency=String(row.currency||'').toUpperCase(),label=sourceLabel(row),value=finite(row[valueField]);if(!period||!currency||value==null)continue;const key=[period,label,currency].join('|'),prior=groups.get(key)||{period,label,currency,value:0};prior.value+=value;groups.set(key,prior);}
  return [...groups.values()].sort((a,b)=>a.period.localeCompare(b.period)||a.currency.localeCompare(b.currency)||a.label.localeCompare(b.label));
}
function supportingTable(rows){return ['| Month | Series | Currency | Sales |','|---|---|---|---:|',...rows.map(row=>`| ${row.period} | ${esc(row.label)} | ${row.currency} | ${money(row.value,row.currency)} |`)].join('\n');}

export function createGeneralAnalyticsService({loadReport}){
  if(typeof loadReport!=='function')throw new Error('loadReport is required');
  return async (_message,{analysisContext:context,onProviderStage}={})=>{
    if(!['channel_sales','product_sales'].includes(context?.requested_subject))return null;
    const reportInput={start_date:context.start_date,end_date:context.end_date,...(context.comparison_start_date?{comparison:'custom',comparison_start:context.comparison_start_date,comparison_end:context.comparison_end_date}:{comparison:'previous_period'})};
    if(context.requested_subject==='product_sales'){
      const pending=Array.isArray(context.pending_product_candidates)?context.pending_product_candidates:[];
      let resolved=pending.find(choice=>choice.product_ref===context.product_ref)||null,selection=pending.length?requestedChoice(_message,pending):{attempted:false,choice:null,selection_kind:null};
      if(!resolved&&selection.choice)resolved=selection.choice;
      if(pending.length&&!resolved){const prefix=selection.attempted?'That selection is not one of the offered governed identities.\n\n':'';return{answer:prefix+choiceList(context.entity_query,pending),tools:['get_ecommerce_report_v2_evidence'],evidence:{kind:'governed_product_sales',subject:'product_sales',entity_query:context.entity_query,entity_refs:pending.map(choice=>choice.product_ref),ambiguous:true,candidates:pending,metrics:['sales'],periods:[{start_date:context.start_date,end_date:context.end_date}],channel:context.channel,currencies:context.currencies,rows:[],diagnostic:{stage:'selection_validation',code:selection.attempted?'SELECTION_NOT_OFFERED':'SELECTION_REQUIRED'}}};}
      const providerInput={...reportInput,...(resolved?{selected_product_ref:resolved.product_ref,selected_source_refs:resolved.sources.map(source=>source.source_product_ref)}:{})};
      onProviderStage?.({stage:'product_evidence_retrieval',code:'PROVIDER_REQUEST',selected_product_ref:resolved?.product_ref||null});
      let report;try{report=await loadReport('products',providerInput);}catch(error){if(!resolved)throw error;onProviderStage?.({stage:'product_evidence_retrieval',code:'PRODUCT_SELECTION_RETRIEVAL_FAILED',selected_product_ref:resolved.product_ref});return{answer:`I validated your selection as **${esc(resolved.product_ref)}**, but its sales evidence could not be retrieved. The selection has been retained; retry the sales request or quote the correlation ID.`,tools:['get_ecommerce_report_v2_evidence'],evidence:{kind:'governed_product_sales',subject:'product_sales',entity_query:context.entity_query,entity_refs:[resolved.product_ref],resolved_product_ref:resolved.product_ref,selected_candidate:resolved,metrics:['sales'],periods:[{start_date:context.start_date,end_date:context.end_date}],channel:context.channel,currencies:context.currencies,rows:[],retrieval_failed:true,diagnostic:{stage:'product_evidence_retrieval',code:'PRODUCT_SELECTION_RETRIEVAL_FAILED'}}};}
      const query=normalizeProductTitle(context.entity_query),all=[...(report.rows||[]),...(report.comparison_rows||[])],titleMatches=all.filter(row=>[row.canonical_title,row.source_title,row.normalized_title].some(title=>normalizeProductTitle(title)===query)),matches=titleMatches.filter(row=>(context.channel!=='online'||String(row.channel).toLowerCase()==='online')&&(!context.currencies?.length||context.currencies.includes(String(row.currency||'').toUpperCase()))),choices=productChoices(matches),identities=choices.map(choice=>choice.product_ref);
      if(!matches.length)return{answer:resolved?`I validated your selection as **${esc(resolved.product_ref)}**, but no sales evidence was returned for the preserved period, channel and currency scope. The selected identity remains active.`:`I could not resolve **${esc(context.entity_query)}** to governed line-item product evidence for ${context.start_date} to ${context.end_date}. Please use the catalogue title or choose from a product search; no inventory was queried.`,tools:['get_ecommerce_report_v2_evidence'],evidence:{kind:'governed_product_sales',subject:'product_sales',entity_query:context.entity_query,entity_refs:resolved?[resolved.product_ref]:[],resolved_product_ref:resolved?.product_ref,selected_candidate:resolved||undefined,metrics:['sales'],periods:[{start_date:context.start_date,end_date:context.end_date}],rows:[],retrieval_failed:Boolean(resolved),diagnostic:resolved?{stage:'product_evidence_validation',code:'SELECTED_PRODUCT_EVIDENCE_EMPTY'}:undefined}};
      if(!resolved)resolved=choices.find(choice=>choice.product_ref===context.product_ref)||null;
      if(choices.length>1&&!resolved){selection=requestedChoice(_message,choices);if(selection.choice)resolved=selection.choice;else {const prefix=selection.attempted?'That selection is not one of the offered governed identities.\n\n':'';return{answer:prefix+choiceList(context.entity_query,choices),tools:['get_ecommerce_report_v2_evidence'],evidence:{kind:'governed_product_sales',subject:'product_sales',entity_query:context.entity_query,entity_refs:identities,ambiguous:true,candidates:choices,metrics:['sales'],periods:[{start_date:context.start_date,end_date:context.end_date}],channel:context.channel,currencies:context.currencies,rows:[],diagnostic:{stage:'selection_validation',code:selection.attempted?'SELECTION_NOT_OFFERED':'SELECTION_REQUIRED'}}};}}
      resolved=resolved||choices[0];
      const selected=matches.filter(row=>row.product_ref===resolved.product_ref),rows=aggregate(selected,'product_sales'),answer=[`# Sales for ${esc(selected[0]?.canonical_title||selected[0]?.source_title||context.entity_query)}`,`**Resolved entity:** ${resolved.product_ref} · **Applied period:** ${context.start_date} to ${context.end_date}${context.partial_period?' (partial end period)':''} · **Channel:** ${context.channel||'online and in-store'} · **Currencies:** ${context.currencies?.length?context.currencies.join(', '):'source-native currencies'}.`,supportingTable(rows),'','Currencies and source-native line-item sales remain separate. Reporting-family membership may group source products without changing their identities. Missing evidence is unavailable, not zero. No inventory was queried.'].join('\n\n');
      return{answer,tools:['get_ecommerce_report_v2_evidence'],inline_chart:context.output_preference==='chart'?chart('product-sales','Monthly product sales',`${context.start_date} to ${context.end_date}`,'Line-item sales',rows):null,evidence:{kind:'governed_product_sales',subject:'product_sales',entity_query:context.entity_query,entity_refs:[resolved.product_ref],resolved_product_ref:resolved.product_ref,selected_candidate:resolved,metrics:['sales'],periods:[{start_date:context.start_date,end_date:context.end_date}],grain:'line_item_month',channel:context.channel,currencies:context.currencies,rows,source_rows:selected,diagnostics:[{stage:'selection_validation',code:resolved?'SELECTION_VALIDATED':'SELECTION_IMPLICIT'},{stage:'provider_arguments',code:'SELECTED_IDENTITY_BOUND',selected_product_ref:resolved.product_ref,source_reference_count:resolved.sources.length},{stage:'evidence_validation',code:'SELECTED_IDENTITY_MATCHED',matched_source_row_count:selected.length},{stage:'delivery',code:'PRODUCT_SALES_DELIVERED'}]}};
    }
    const [sales,eventResult]=await Promise.all([loadReport('sales',reportInput),context.explanation_requested?loadReport('context',reportInput).then(value=>({status:'fulfilled',value}),()=>({status:'rejected'})):Promise.resolve(null)]);
    const events=eventResult?.value;
    const selected=list=>(list||[]).filter(row=>(context.channel!=='online'||isOnline(row))&&(!context.currencies?.length||context.currencies.includes(String(row.currency||'').toUpperCase()))&&!context.exclusions?.includes(MONTH_NAMES[Number(month(row).slice(5))]));
    const current=selected(sales.rows),comparison=selected(sales.comparison_rows),rows=aggregate(current),prior=aggregate(comparison),diagnostics=migrationDiagnostics(current,comparison);
    const transition=[context.start_date,context.comparison_start_date].some(start=>start&&start<='2025-11-30')&&[context.end_date,context.comparison_end_date].some(end=>end&&end>='2025-11-01');
    const lines=['# Canonical finance sales by source',
      current.length?'**Supported finding:** The retrieved canonical finance evidence supports currency-separated source components. Overall business-level online year-on-year performance remains unknown.':'**Supported finding:** No current-period finance rows were retrieved; missing evidence is not zero. Overall online performance remains unknown.',
      transition?'**Migration:** November 2025 sales moved between WooCommerce and Shopify around the confirmed 20 November public launch. A Woo-only year-on-year decline is a source-only change and is unsuitable as the headline for overall online performance.':null,
      `**Business-level online comparison withheld, including within each currency:** ${ONLINE_COMPARISON_BOUNDARY.reason}`,
      `**Applied periods:** ${context.start_date} to ${context.end_date}${context.partial_period?' (partial final month)':''}; comparison ${sales.comparison?.start_date||context.comparison_start_date||'unavailable'} to ${sales.comparison?.end_date||context.comparison_end_date||'unavailable'}.`,
      'Finance sale transaction counts are ledger counts, not validated distinct ecommerce orders. Canonical net gross uses accounting refunds; source-native operational sales, eligible orders and order-cohort refunds are different measures and have not been substituted.',
      '## Source components',
      '| Period | Source / channel | Currency | Canonical net gross | Finance sale transactions | Coverage |',
      '|---|---|---|---:|---:|---|'];
    for(const [label,list] of [['Current',current],['Comparison',comparison]]){
      const components=financeComponents(list);
      if(!components.length)lines.push(`| ${label} | Unavailable | — | — | — | No rows; not zero |`);
      for(const item of components)lines.push(`| ${label} | ${esc(item.source)} / ${esc(item.channel)} | ${item.currency} | ${money(item.net_gross,item.currency)} | ${item.sales_transaction_count==null?'Unavailable':item.sales_transaction_count.toLocaleString('en-GB')} | ${item.observed_days} observed days; completeness unknown |`);
    }
    for(const item of diagnostics.periods){
      if(item.prelaunch_dates.length)lines.push(`**${item.period} Shopify evidence before launch:** ${item.prelaunch_dates.join(', ')} precedes ${diagnostics.public_launch_date}. These dates are retained; test, early trading or date semantics require governed investigation.`);
      if(item.overlap_dates.length)lines.push(`**${item.period} Woo / Shopify overlap:** ${item.overlap_dates.join(', ')}. Legitimate overlap is preserved. Same-day activity does not establish duplicates; no dates or amounts were discarded.`);
    }
    if(context.explanation_requested){
      lines.push('## Confirmed contextual events');
      for(const [label,key] of [['Current period','current'],['Comparison period','comparison']]){
        const items=(events?.context?.[key]||[]).filter(event=>!event.status||event.status==='confirmed');
        lines.push(`**${label}:**`,...(items.length?items.map(event=>`- ${esc(event.title||event.name||event.summary||event.id)} · ${esc(event.id)} · ${esc(event.effective_from||'date unknown')} to ${esc(event.effective_to||event.effective_from||'date unknown')} · ${esc(event.content||event.description||'')} · source ${esc(event.source_reference||'unavailable')}. Documented context; temporal overlap does not prove causality.`):[eventResult?.status==='rejected'?'- Governed context retrieval failed; campaign context is unknown.':'- No confirmed contextual event was retrieved; campaign context is unknown, not absent.']));
      }
      lines.push('## Hypotheses','Campaign, traffic and merchandising effects remain hypotheses. Migration prevents interpreting a Woo-only change as a business decline; this evidence does not quantify migration uplift or campaign causality.');
    }
    lines.push('<details>','<summary>Daily provenance and supporting evidence</summary>','',
      '| Period | Date | Source / channel | Currency | Canonical net gross | Finance sale transactions |',
      '|---|---|---|---|---:|---:|',
      ...[['Current',current],['Comparison',comparison]].flatMap(([label,list])=>list.map(row=>`| ${label} | ${esc(row.date||row.period)} | ${esc(financeSource(row))} / ${esc(row.channel)} | ${row.currency} | ${money(row.net_gross,row.currency)} | ${row.sales_transaction_count??row.orders??'Unavailable'} |`)),
      '', 'Daily rows identify source and date evidence; query execution does not prove collection completeness. All returned dates and source components are retained.', '</details>');
    return{answer:lines.filter(x=>x!==null).join('\n'),tools:['get_ecommerce_report_v2_evidence',...(eventResult?['get_business_context','search_knowledge']:[])],inline_chart:context.output_preference==='chart'?chart('channel-sales','Canonical finance by source and currency',`${context.start_date} to ${context.end_date}`,'Canonical net gross',rows):null,evidence:{kind:context.explanation_requested?'governed_sales_explanation':'governed_channel_sales',subject:'channel_sales',metrics:['sales'],periods:[{start_date:context.start_date,end_date:context.end_date},...(context.comparison_start_date?[{start_date:context.comparison_start_date,end_date:context.comparison_end_date}]:[])],grain:'month',channel:context.channel||'online_vs_instore',rows,comparison_rows:prior,source_rows:{current,comparison},source_components:{current:financeComponents(current),comparison:financeComponents(comparison)},online_comparison:ONLINE_COMPARISON_BOUNDARY,migration_diagnostics:diagnostics,documented_events:events?.context||null,context_status:eventResult?.status||'not_requested'}};
  };
}

import { normalizeProductTitle } from './ecommerce-report-v2.js';

const finite=value=>Number.isFinite(Number(value))?Number(value):null;
const esc=value=>String(value??'').replaceAll('|','\\|').replaceAll('\n',' ');
const money=(value,currency)=>value==null?'Unavailable':`${currency} ${Number(value).toLocaleString('en-GB',{maximumFractionDigits:2})}`;
const month=value=>String(value?.period||value?.date||'').slice(0,7);
const MONTH_NAMES=['','january','february','march','april','may','june','july','august','september','october','november','december'];
const sourceLabel=row=>row.source_platform==='woo'?'WooCommerce online':row.source_platform==='square'?'Square in-store':row.source_platform==='shopify'&&String(row.channel).toLowerCase().includes('online')?'Shopify online':row.source_platform==='shopify'?'Shopify POS':`${row.source_platform||'Unknown'} ${row.channel||''}`.trim();
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
    const family=choice.reporting_family_relationships.length?choice.reporting_family_relationships.map(esc).join('; '):'No reporting-family relationship recorded in this evidence';
    lines.push(`${index+1}. **${titles}**\n   - Stable product reference: \`${esc(choice.product_ref)}\`\n   - Source platform / store and reference: ${sources}\n   - Reporting-family relationship: ${family}`);
  });
  lines.push('Reply with the choice number or an exact stable product/source reference. I will validate it against only these offered candidates, then run the original sales request with its dates, channel and currency scope unchanged.');
  return lines.join('\n');
}
function requestedChoice(message,choices){
  const text=String(message||'').trim(),number=text.match(/^(?:(?:choice|option)\s*)?#?(\d+)\s*[.!]?$/i);
  if(number)return {attempted:true,choice:choices[Number(number[1])-1]||null};
  const exact=choices.find(choice=>choice.product_ref===text||choice.sources.some(source=>source.source_product_ref===text));
  if(exact)return {attempted:true,choice:exact};
  const looksLikeSelection=/^(?:choice|option|number|#)\b/i.test(text)||/^[a-z]+:[^\s]+:[^\s]+$/i.test(text);
  return {attempted:looksLikeSelection,choice:null};
}

function aggregate(rows,valueField='net_gross'){
  const groups=new Map();
  for(const row of rows||[]){const period=month(row),currency=String(row.currency||'').toUpperCase(),label=sourceLabel(row),value=finite(row[valueField]);if(!period||!currency||value==null)continue;const key=[period,label,currency].join('|'),prior=groups.get(key)||{period,label,currency,value:0};prior.value+=value;groups.set(key,prior);}
  return [...groups.values()].sort((a,b)=>a.period.localeCompare(b.period)||a.currency.localeCompare(b.currency)||a.label.localeCompare(b.label));
}
function supportingTable(rows){return ['| Month | Series | Currency | Sales |','|---|---|---|---:|',...rows.map(row=>`| ${row.period} | ${esc(row.label)} | ${row.currency} | ${money(row.value,row.currency)} |`)].join('\n');}

export function createGeneralAnalyticsService({loadReport}){
  if(typeof loadReport!=='function')throw new Error('loadReport is required');
  return async (_message,{analysisContext:context}={})=>{
    if(!['channel_sales','product_sales'].includes(context?.requested_subject))return null;
    const reportInput={start_date:context.start_date,end_date:context.end_date,...(context.comparison_start_date?{comparison:'custom',comparison_start:context.comparison_start_date,comparison_end:context.comparison_end_date}:{comparison:'previous_period'})};
    if(context.requested_subject==='product_sales'){
      const report=await loadReport('products',reportInput),query=normalizeProductTitle(context.entity_query),all=[...(report.rows||[]),...(report.comparison_rows||[])],titleMatches=all.filter(row=>[row.canonical_title,row.source_title,row.normalized_title].some(title=>normalizeProductTitle(title)===query)),matches=titleMatches.filter(row=>(context.channel!=='online'||String(row.channel).toLowerCase()==='online')&&(!context.currencies?.length||context.currencies.includes(String(row.currency||'').toUpperCase()))),choices=productChoices(matches),identities=choices.map(choice=>choice.product_ref);
      if(!matches.length)return{answer:`I could not resolve **${esc(context.entity_query)}** to governed line-item product evidence for ${context.start_date} to ${context.end_date}. Please use the catalogue title or choose from a product search; no inventory was queried.`,tools:['get_ecommerce_report_v2_evidence'],evidence:{kind:'governed_product_sales',subject:'product_sales',entity_query:context.entity_query,entity_refs:[],metrics:['sales'],periods:[{start_date:context.start_date,end_date:context.end_date}],rows:[]}};
      let resolved=choices.find(choice=>choice.product_ref===context.product_ref)||null;
      if(choices.length>1&&!resolved){const selection=requestedChoice(_message,choices);if(selection.choice)resolved=selection.choice;else {const prefix=selection.attempted?'That selection is not one of the offered governed identities.\n\n':'';return{answer:prefix+choiceList(context.entity_query,choices),tools:['get_ecommerce_report_v2_evidence'],evidence:{kind:'governed_product_sales',subject:'product_sales',entity_query:context.entity_query,entity_refs:identities,ambiguous:true,candidates:choices,metrics:['sales'],periods:[{start_date:context.start_date,end_date:context.end_date}],channel:context.channel,currencies:context.currencies,rows:[]}};}}
      resolved=resolved||choices[0];
      const selected=matches.filter(row=>row.product_ref===resolved.product_ref),rows=aggregate(selected,'product_sales'),answer=[`# Sales for ${esc(selected[0]?.canonical_title||selected[0]?.source_title||context.entity_query)}`,`**Resolved entity:** ${resolved.product_ref} · **Applied period:** ${context.start_date} to ${context.end_date}${context.partial_period?' (partial end period)':''} · **Channel:** ${context.channel||'online and in-store'} · **Currencies:** ${context.currencies?.length?context.currencies.join(', '):'source-native currencies'}.`,supportingTable(rows),'','Currencies and source-native line-item sales remain separate. Reporting-family membership may group source products without changing their identities. Missing evidence is unavailable, not zero. No inventory was queried.'].join('\n\n');
      return{answer,tools:['get_ecommerce_report_v2_evidence'],inline_chart:context.output_preference==='chart'?chart('product-sales','Monthly product sales',`${context.start_date} to ${context.end_date}`,'Line-item sales',rows):null,evidence:{kind:'governed_product_sales',subject:'product_sales',entity_query:context.entity_query,entity_refs:[resolved.product_ref],resolved_product_ref:resolved.product_ref,selected_candidate:resolved,metrics:['sales'],periods:[{start_date:context.start_date,end_date:context.end_date}],grain:'line_item_month',channel:context.channel,currencies:context.currencies,rows,source_rows:selected}};
    }
    const [sales,events]=await Promise.all([loadReport('sales',reportInput),context.explanation_requested?loadReport('context',reportInput):Promise.resolve(null)]),filtered=(sales.rows||[]).filter(row=>(context.channel!=='online'||String(row.channel).toLowerCase()==='online')&&!context.exclusions?.includes(MONTH_NAMES[Number(month(row).slice(5))])),rows=aggregate(filtered);
    const lines=['# Monthly online versus in-store sales',`**Applied rolling window:** ${context.start_date} to ${context.end_date}${context.partial_period?' (the final month is partial)':''}. Historical online uses governed WooCommerce evidence where applicable; historical retail uses Square evidence. Shopify POS is labelled separately and is not treated as all historical retail.`,supportingTable(rows),'','Currencies are separate and never converted. Missing provider/month combinations render as gaps, never zero.'];
    if(context.explanation_requested){const prior=aggregate(sales.comparison_rows||[]),sum=list=>list.reduce((n,row)=>n+row.value,0);lines.push('## Measured change',`Current-period retrieved sales: ${sum(rows).toLocaleString('en-GB')}; comparison-period retrieved sales: ${sum(prior).toLocaleString('en-GB')}. Compare within the same currency and source definition; a combined cross-currency causal change is not asserted.`,'## Confirmed contextual events',...(events?.context?.current?.length?events.context.current.map(event=>`- ${esc(event.title||event.name||event.summary||event.id)} (documented; temporal overlap does not prove causality).`):['- No confirmed contextual event was retrieved for the applied period.']),'## Hypotheses','- Channel, merchandising, traffic or stock effects are possible hypotheses only; this evidence does not establish causality.');}
    return{answer:lines.join('\n\n'),tools:['get_ecommerce_report_v2_evidence',...(events?['search_knowledge']:[])],inline_chart:context.output_preference==='chart'?chart('channel-sales','Online versus in-store sales by month',`${context.start_date} to ${context.end_date}`,'Net sales',rows):null,evidence:{kind:context.explanation_requested?'governed_sales_explanation':'governed_channel_sales',subject:'channel_sales',metrics:['sales'],periods:[{start_date:context.start_date,end_date:context.end_date},...(context.comparison_start_date?[{start_date:context.comparison_start_date,end_date:context.comparison_end_date}]:[])],grain:'month',channel:'online_vs_instore',rows,comparison_rows:aggregate(sales.comparison_rows||[]),documented_events:events?.context||null}};
  };
}

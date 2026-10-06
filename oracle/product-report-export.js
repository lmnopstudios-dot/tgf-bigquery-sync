import ExcelJS from 'exceljs';
import { PRODUCT_REPORT_CAPABILITIES, validateProductReportConfig } from './product-report-config.js';
import { shopifyProductId, canonicalProductUrl } from './product-priority.js';

const number=value=>value!==null&&value!==undefined&&value!==''&&typeof value!=='boolean'&&Number.isFinite(Number(value))?Number(value):null;
const idOrder=(a,b)=>BigInt(a.product_id)<BigInt(b.product_id)?-1:BigInt(a.product_id)>BigInt(b.product_id)?1:0;
export const PRODUCT_REPORT_METHOD=Object.freeze({version:1,join:'Stable Shopify parent product IDs for commerce; unique canonical HTTPS product URL for GA4/Search Console. Query strings and fragments removed. No title, variant or cross-origin guesses.',sort:'Requested metric/direction; monetary values only in the named presentment currency. Missing/unavailable values last for either direction. Ties: numeric Shopify product ID ascending.',missing:'Only numeric provider evidence is observed, including explicit zero. Omitted rows, incomplete sums, failed providers and unsupported metrics remain blank; catalogue presence never implies zero.',population:'Every retrieved current Online Store published Shopify parent product (or explicit product ID subset), including unmatched products. Top-N is applied after ranking; source coverage and catalogue completeness are separate.'});

export function rankProductReport(catalogue,sources,rawConfig){
  const config=validateProductReportConfig(rawConfig),products=catalogue.products.filter(p=>!config.population.product_ids||config.population.product_ids.includes(p.product_id));
  // Validate uniqueness against the full catalogue, even for a selected subset.
  const urls=new Map(),origins=new Set(catalogue.products.map(p=>new URL(p.url).origin));
  for(const p of catalogue.products)urls.set(p.url,urls.has(p.url)?null:p.product_id);
  const byId=new Map(products.map(p=>[p.product_id,p])),observed=new Map(products.map(p=>[p.product_id,{}]));
  const invalid=new Set();
  for(const name of config.metrics){
    const capability=PRODUCT_REPORT_CAPABILITIES[name],binding=capability.provider_binding;
    if(!binding||sources[binding.provider]?.status!=='available')continue;
    for(const row of sources[binding.provider].rows||[]){
      if(binding.provider==='sales'&&(row.evidence_window||row.window)==='history')continue;
      let id;
      if(binding.provider==='sales')id=shopifyProductId(row.product_id);
      else {const raw=row.url||row.landing_path||row.page;const url=String(raw||'').startsWith('/')&&!String(raw).startsWith('//')&&origins.size===1?canonicalProductUrl(`${[...origins][0]}${raw}`):canonicalProductUrl(raw);id=urls.get(url);}
      if(!byId.has(id))continue;
      const currency=capability.money?String(row.currency||''):null;
      if(capability.money&&!/^[A-Z]{3}$/.test(currency))continue;
      const values=observed.get(id),key=capability.money?`${name}:${currency}`:name,invalidKey=`${id}:${key}`,value=number(row[binding.field]);
      if(value===null||!capability.money&&value<0){invalid.add(invalidKey);values[key]=null;continue;}
      if(invalid.has(invalidKey))continue;
      // Commerce counts are product totals, repeated once per currency by SQL.
      // Conflicting totals are unavailable rather than summed or guessed.
      if(binding.provider==='sales'&&!capability.money){if(key in values&&values[key]!==value){invalid.add(invalidKey);values[key]=null;}else values[key]=value;}
      else values[key]=(values[key]??0)+value;
    }
  }
  const currencies=[...new Set([...observed.values()].flatMap(values=>Object.keys(values).filter(k=>k.startsWith('product_sales:')).map(k=>k.split(':')[1])))].sort();
  if(config.currency&&!currencies.includes(config.currency))currencies.push(config.currency);currencies.sort();
  const columns=[{key:'title',header:'Product'},{key:'url',header:'Product link'}];
  for(const name of config.metrics){const c=PRODUCT_REPORT_CAPABILITIES[name];if(c.money&&c.supported){for(const currency of currencies.length?currencies:['unavailable'])columns.push({key:`${name}:${currency}`,header:`Discounted product line sales (${currency})`,metric:name,currency});}else columns.push({key:name,header:({units_sold:'Units sold (original quantity)',product_orders:'Distinct orders containing product',landing_sessions:'Product landing sessions',organic_clicks:'Organic clicks',organic_impressions:'Organic impressions'}[name]||`${name.replaceAll('_',' ')} (unavailable)`),metric:name});}
  const sortKey=PRODUCT_REPORT_CAPABILITIES[config.sort.metric]?.money?`${config.sort.metric}:${config.currency}`:config.sort.metric;
  const rows=products.map(p=>({...p,metrics:observed.get(p.product_id),evidence_state:Object.fromEntries(config.metrics.map(name=>{const c=PRODUCT_REPORT_CAPABILITIES[name],values=observed.get(p.product_id),value=c.money?values[`${name}:${config.currency}`]:values[name];return [name,!c.supported?'unsupported':sources[c.provider_binding.provider]?.status!=='available'?'unavailable':value==null?'unmatched':value===0?'observed_zero':'observed'];}))})).sort((a,b)=>{
    const x=a.metrics[sortKey]??null,y=b.metrics[sortKey]??null;
    return (x===null)-(y===null)||(config.sort.direction==='asc'?1:-1)*((x??0)-(y??0))||idOrder(a,b);
  });
  const total=rows.length,selected=config.population.limit?rows.slice(0,config.population.limit):rows;
  const availability=Object.fromEntries(config.metrics.map(name=>{const c=PRODUCT_REPORT_CAPABILITIES[name],provider=c.provider_binding?.provider,source=sources[provider],matched=rows.filter(row=>Object.entries(row.metrics).some(([key,value])=>(key===name||key.startsWith(`${name}:`))&&value!==null)).length;return[name,{status:!c.supported?'unsupported':source?.status||'unavailable',provider_binding:c.provider_binding,definition:c.definition,matched_product_count:matched,unmatched_product_count:total-matched,complete:Boolean(source?.complete),error_code:source?.error_code||null}];}));
  const any=config.sort.metric?rows.some(row=>row.metrics[sortKey]!=null):rows.some(row=>Object.values(row.metrics).some(value=>value!==null));
  return {rows:selected,columns,population_count:total,evidence_availability:availability,ranking_status:!any?'unavailable':!catalogue.complete||Object.values(availability).some(s=>!s.complete||s.unmatched_product_count||s.status!=='available')?'provisional':'available'};
}
export async function productReportWorkbook(envelope){
  const workbook=new ExcelJS.Workbook();workbook.creator='Oracle';workbook.created=new Date(envelope.generated_at);
  const sheet=workbook.addWorksheet(envelope.manifest.complete_catalogue?'Product report':'Products - incomplete');
  sheet.columns=envelope.report_columns.map(column=>({header:column.header,width:column.key==='title'?48:column.key==='url'?65:30}));
  for(const row of envelope.rows){const added=sheet.addRow(envelope.report_columns.map(column=>column.key==='title'?row.title:column.key==='url'?{text:row.url,hyperlink:row.url}:row.metrics[column.key]??null));added.getCell(2).font={color:{argb:'FF0563C1'},underline:true};added.alignment={vertical:'top',wrapText:true};}
  sheet.getRow(1).font={bold:true};sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,sheet.rowCount),column:sheet.columnCount}};
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

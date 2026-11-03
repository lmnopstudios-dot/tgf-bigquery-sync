// Shared stock intent contract. Catalogue evidence, never spelling heuristics,
// establishes product identity. Instructions are not catalogue search terms.
export function validateStockScope(value){
  if(value==null)return null;
  const allowed=['locations','location_groups','excluded_location_terms','variant_detail','layout','format'];
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('Invalid stock scope');
  for(const k of ['locations','location_groups','excluded_location_terms'])if(!Array.isArray(value[k])||value[k].length>12||value[k].some(v=>typeof v!=='string'||!v.trim()||v.length>100))throw Error('Invalid stock locations');
  if(value.location_groups.some(v=>!['pos','online','all'].includes(v))||typeof value.variant_detail!=='boolean'||!['rows','matrix'].includes(value.layout)||!['table','xlsx'].includes(value.format))throw Error('Invalid stock presentation');
  return Object.fromEntries(allowed.map(k=>[k,Array.isArray(value[k])?[...new Set(value[k])]:value[k]]));
}
const clean=s=>s.replace(/^[\s,;:]+|[\s,;:.!?]+$/g,'').trim();
function locationFields(text){
  const out={locations:[],location_groups:[]};
  for(const part of text.split(/\s*(?:,|\band\b|&|\+)\s*/i)){
    let name=clean(part).replace(/^(?:also|include|at|in|the)\s+/i,'').replace(/\s+(?:locations?|stock)$/i,'');
    if(!name)continue;
    if(/^(?:all(?: active)?|every(?: active)?)$/i.test(name))out.location_groups.push('all');
    else if(/^(?:pos|stores?|in[- ]store)$/i.test(name))out.location_groups.push('pos');
    else if(/^online$/i.test(name))out.location_groups.push('online');
    else out.locations.push(name);
  }
  return out;
}
export function parseCurrentStock(message,previous=null){
  const text=String(message||'').trim(),base=previous?.requested_subject==='current_stock'&&!previous.inventory_report?previous:null;
  if(/\b(?:historical|history|sales|sold|velocity|capacity|components?|stones?|yesterday|last year|last month)\b/i.test(text))return null;
  const scope={locations:[],location_groups:[],excluded_location_terms:[],variant_detail:false,layout:'rows',format:'table',...(base?.stock_scope||{})};
  // Anchored refinements cannot steal unrelated sales/product questions.
  const refine=text.match(/^(?:please\s+)?(just|only|include|add|also include)\s+(.+?)(?:\s+too)?[.!]?$/i);
  const formatOnly=/^(?:please\s+)?(?:put|export|download|give|show|make)\s+(?:that|it|this)(?:\s+(?:as|in|into))?\s+(?:an?\s+)?(?:excel(?: workbook| spreadsheet)?|xlsx|table)[.!]?$/i.test(text);
  let entity=null,locationText=null,continuation=false;
  if(base&&formatOnly){continuation=true;scope.format=/excel|xlsx/i.test(text)?'xlsx':'table';}
  else if(base&&refine&&!/\b(?:sales|products?|customers?|made.to.order|enquire|tags?)\b/i.test(refine[2])){
    const next=locationFields(refine[2]);
    if(!next.locations.length&&!next.location_groups.length)return null;
    continuation=true;
    if(/include|add/i.test(refine[1])){scope.locations=[...scope.locations,...next.locations];scope.location_groups=[...scope.location_groups,...next.location_groups];}
    else Object.assign(scope,next);
  }else{
    const match=text.match(/\b(?:current\s+)?(?:stock(?:\s+levels?)?|inventory(?:\s+levels?)?)\s+(?:for|of)\s+([\s\S]+)/i)||text.match(/\bhow many\s+(.+?)\s+(?:do we have(?:\s+in stock)?|are in stock)[?.!]*$/i)||text.match(/^(?:are|do we have(?: any)?)\s+(.+?)\s+in stock[?.!]*$/i);
    if(!match)return null;
    let body=match[1];
    const lead=body.match(/^((?:pos|in[- ]store|online)(?:\s+locations?)?(?:\s+and\s+(?:pos|online)(?:\s+locations?)?)?)\s+for\s+(?:each of\s+)?(?:the\s+)?(.+)$/i);
    if(lead){locationText=lead[1];body=lead[2];}
    const at=body.match(/\s+(?:at|in|across)\s+(.+)$/i);
    if(at){locationText=at[1].split(/\.(?:\s|$)|;|\b(?:exclude|show|include|sort)\b/i)[0];body=body.slice(0,at.index);}
    entity=clean(body.split(/,?\s*\b(?:broken down|by every|by each|for each|with stock|exclude|show one|include|create an?|put (?:that|it))\b|[.;\n]/i)[0]).replace(/\s+var(?:iants?|ients?)\b.*$/i,'').replace(/^(?:each of\s+)?the\s+/i,'');
    entity=clean(entity.replace(/^["“']|["”']$/g,''));
    if(!entity||entity.length>120)return null;
    Object.assign(scope,{locations:[],location_groups:[],excluded_location_terms:[],variant_detail:false,layout:'rows',format:'table'});
    if(locationText)Object.assign(scope,locationFields(locationText));
    else scope.location_groups=['all'];
  }
  if(/\b(?:every|each|all)\s+(?:variant|size)|\bvar(?:iants|ients)\b/i.test(text))scope.variant_detail=true;
  if(scope.variant_detail)scope.layout='matrix';
  if(/one row per|one column per|broken down/i.test(text))scope.layout='matrix';
  if(/\b(?:excel|xlsx|spreadsheet|workbook)\b/i.test(text))scope.format='xlsx';
  if(/\bexclude\s+(?:both\s+|the\s+)?workshops?\b/i.test(text))scope.excluded_location_terms=['workshop'];
  const resolved=validateStockScope(scope);
  const location=resolved.location_groups.includes('all')?null:[...resolved.locations,...resolved.location_groups].join(', ')||null;
  return {entity_query:entity||base.entity_query,location,all_locations:location==null,stock_scope:resolved,continuation};
}

import {inventoryScopeError} from './inventory-export-intent.js';
// Governed variant inventory predicates. No title matching, Shopify writes or
// store IDs inferred from names. Names are bound to native locations at read time.
const fail=inventoryScopeError;
export const FILTERED_INVENTORY_ENTITY='filtered variant inventory';
const statuses=['ACTIVE','DRAFT','UNLISTED','ARCHIVED'];
const operators={'>':'gt','>=':'gte','<':'lt','<=':'lte'};
const clean=value=>String(value).normalize('NFKC').trim();
const allowed=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));
export function validateInventoryReportConfig(value){
 if(value==null)return null;
 if(!allowed(value,['version','statuses','excluded_tags','pos','online','exclude_workshops','require_known_available','sort'])||value.version!==1)throw fail();
 if(!Array.isArray(value.statuses)||!value.statuses.length||value.statuses.some(s=>!statuses.includes(s)))throw fail();
 if(!Array.isArray(value.excluded_tags)||value.excluded_tags.some(t=>typeof t!=='string'||!t.trim()||t.length>100))throw fail();
 const group=(g,single)=>{if(!allowed(g,['names','operator','threshold'])||!Array.isArray(g.names)||!g.names.length||g.names.length>20||single&&g.names.length!==1||g.names.some(n=>typeof n!=='string'||!n.trim()||n.length>100)||!['gt','gte','lt','lte'].includes(g.operator)||typeof g.threshold!=='number'||!Number.isFinite(g.threshold))throw fail();const names=g.names.map(clean);if(new Set(names.map(n=>n.toLowerCase())).size!==names.length)throw fail();return{names,operator:g.operator,threshold:g.threshold};};
 const pos=group(value.pos,false),online=group(value.online,true);
 if(pos.names.some(n=>online.names.some(o=>o.toLowerCase()===n.toLowerCase()))||value.require_known_available!==true||typeof value.exclude_workshops!=='boolean'||!allowed(value.sort,['metric','direction'])||value.sort.metric!=='pos_total_available'||!['asc','desc'].includes(value.sort.direction))throw fail();
 if(value.exclude_workshops&&[...pos.names,...online.names].some(n=>/\bworkshops?\b/i.test(n)))throw fail();
 return{version:1,statuses:statuses.filter(s=>value.statuses.includes(s)),excluded_tags:[...new Set(value.excluded_tags.map(t=>clean(t).toLowerCase()))].sort(),pos,online,exclude_workshops:value.exclude_workshops,require_known_available:true,sort:{metric:'pos_total_available',direction:value.sort.direction}};
}
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const inventoryReportConfigKey=value=>JSON.stringify(canonical(validateInventoryReportConfig(value)));
const comparisonPattern=/(>=|<=|>|<|at least|at most|greater than|more than|fewer than|less than|above|below|over|under)\s*(-?\d+(?:\.\d+)?)/gi;
const comparisonOperator=op=>operators[op]||({'at least':'gte','at most':'lte','greater than':'gt','more than':'gt','fewer than':'lt','less than':'lt',above:'gt',below:'lt',over:'gt',under:'lt'})[op.toLowerCase()];
function locationNames(value){
 let text=value.replace(/^.*?\b(?:where|with)\s+/i,'').trim();
 text=text.replace(/^[\s,:;()]+|[\s,:;().]+$/g,'');
 const prefix=/^(?:(?:and|the|sum|of|combined|total|POS|retail|available|units?|stock|inventory|across|at|in|locations?|stores?|is|must|be)\b[\s:=(]*)+/i;
 text=text.replace(prefix,'');
 return text.split(/\s*\+\s*|\s*,\s*|\s+and\s+/i).map(n=>clean(n).replace(/^(?:available\s*\(|["'])|["')]+$/g,'').replace(/(?:\s+(?:available|units?|stock|inventory|combined|together|total))+[\s:()]*$/i,'').trim()).filter(Boolean);
}
export function filteredInventoryScope(message){
 const text=String(message||'').normalize('NFKC').replace(/&gt;/gi,'>').replace(/&lt;/gi,'<').replace(/≥/g,'>=').replace(/≤/g,'<=').replace(/[*`“”]/g,'').replace(/^\s*(?:[-•]|\d+[.)])\s+/gm,'').replace(/[\t ]+/g,' ').trim();
 const matches=[...text.matchAll(comparisonPattern)];
 if(!matches.length||!(/\b(?:variants?|products?|stock|inventory)\b/i.test(text))||!(/\b(?:available|POS|RTS)\b/i.test(text)))return null;
 const declaration=text.match(/\b(?:POS|retail|store)\s+(?:locations?|stores?)\s*[:=]\s*([^\n;.]+)/i);
 const declaredPOS=declaration?locationNames(declaration[1]):[];
 const onlineDeclaration=text.match(/\bonline(?:\s+RTS)?\s+location\s*[:=]\s*([^\n;.]+)/i);
 const declaredOnline=onlineDeclaration?locationNames(onlineDeclaration[1]):[];
 const groups=matches.map((m,i)=>{
   const before=text.slice(i?matches[i-1].index+matches[i-1][0].length:0,m.index).trim().split(/[.;\n]/).filter(Boolean).at(-1)||'';
   const after=text.slice(m.index+m[0].length,i+1<matches.length?matches[i+1].index:undefined).trim().split(/[.;\n]/)[0];
   const suffix=/^(?:available|units?|stock|inventory|across|at|in)\b/i.test(after),part=suffix?after:before;
   let names=locationNames(part);const posLabel=/\bPOS\b/i.test(part),onlineLabel=/\bonline\s+RTS\b/i.test(part);
   if(posLabel&&(!names.length||names.every(n=>/^(?:available|stock|total|units)$/i.test(n))))names=declaredPOS;
   if(onlineLabel&&names.length===1&&/^online\s+RTS$/i.test(names[0]))names=declaredOnline.length?declaredOnline:['Online Ready to Ship'];
   return {names,operator:comparisonOperator(m[1]),threshold:Number(m[2])};
 });
 const unique=[...new Map(groups.map(g=>[JSON.stringify(g),g])).values()];
 if(unique.length!==2)throw fail();
 const pos=unique.find(g=>g.names.length>1),online=unique.find(g=>g!==pos);if(!pos||!online||online.names.length!==1)throw fail();
 let requested=['ACTIVE','DRAFT','UNLISTED'];
 if(/\bactive(?:[- ]only)?\s+(?:(?:Shopify|product)\s+)?(?:variants?|products?)\b|\b(?:status|products?)\s*:\s*active(?:\s+only)?\b/i.test(text))requested=['ACTIVE'];
 if(/\bactive\s+and\s+draft\s+(?:product\s+)?(?:variants?|products?)\b/i.test(text))requested=['ACTIVE','DRAFT'];
 for(const clause of text.split(/[.!;\n]/))if(/\bexclud(?:e|ing)\b/i.test(clause)&&/\b(?:draft|unlisted|archived)\b/i.test(clause))requested=requested.filter(s=>!new RegExp(`\\b${s}\\b`,'i').test(clause));
 const tags=[...text.matchAll(/\b(?:exclude|excluding|without)\s+(?:the\s+)?(?:exact\s+)?["']?([\w-]+)["']?\s+tags?\b/gi)].map(m=>m[1]);
 for(const m of text.matchAll(/\b(?:exclude|excluding|without)\s+(?:products?\s+)?(?:(?:with|having)\s+)?(?:the\s+)?(?:exact\s+)?(?:tagged|tags?\s*:)\s*["']?([\w-]+)["']?/gi))tags.push(m[1]);
 if(/\binclude\s+made[- ]to[- ]order\b/i.test(text)&&tags.some(t=>t.toLowerCase()==='made-to-order'))throw fail();
 const config=validateInventoryReportConfig({version:1,statuses:requested,excluded_tags:tags,pos,online,exclude_workshops:/\bexclude\s+(?:the\s+)?workshops?\b/i.test(text),require_known_available:true,sort:{metric:'pos_total_available',direction:/\b(?:total\s+POS|POS\s+total)(?:\s+stock)?\s*,?\s*(?:asc(?:ending)?|lowest first)\b/i.test(text)?'asc':'desc'}});
 return{entity_query:FILTERED_INVENTORY_ENTITY,location:null,all_locations:true,inventory_report:config};
}
export function resolveInventoryGroups(config,locations){
 const groups={},failures=[];for(const key of ['pos','online']){groups[key]=[];for(const name of config[key].names){const matches=locations.filter(l=>l.isActive&&clean(l.name).toLowerCase()===name.toLowerCase()&&(!config.exclude_workshops||!/\bworkshops?\b/i.test(l.name)));if(matches.length!==1)failures.push({stage:'location_resolution',code:matches.length?'INVENTORY_LOCATION_AMBIGUOUS':'INVENTORY_LOCATION_MISSING',requested_name:name});else groups[key].push({id:matches[0].id,name:matches[0].name});}}
 return{groups,failures};
}
const compare=(a,g)=>({gt:a>g.threshold,gte:a>=g.threshold,lt:a<g.threshold,lte:a<=g.threshold})[g.operator];
export function inventoryVariantSelection(e){
 const c=validateInventoryReportConfig(e.inventory_report);if(!c)return null;
 const {groups,failures}=resolveInventoryGroups(c,e.locations),rows=[];
 for(const p of e.products)for(const v of p.variants){const required=[...groups.pos,...groups.online];const quantities=required.map(l=>v.locations.find(q=>q.location_id===l.id)?.available);const known=!failures.length&&required.length===c.pos.names.length+1&&v.inventoryItem?.tracked===true&&quantities.every(n=>typeof n==='number'&&Number.isFinite(n));const pos=known?quantities.slice(0,groups.pos.length).reduce((a,n)=>a+n,0):null,online=known?quantities.at(-1):null;
 rows.push({p,v,state:!known?'unknown':compare(pos,c.pos)&&compare(online,c.online)?'qualified':'does_not_match',pos_total_available:pos,online_available:online});}
 rows.sort((a,b)=>Number(b.state==='qualified')-Number(a.state==='qualified')||(c.sort.direction==='desc'?-1:1)*((a.pos_total_available??0)-(b.pos_total_available??0))||String(a.v.id).localeCompare(String(b.v.id)));
 return{groups,rows,qualified:rows.filter(r=>r.state==='qualified'),evaluated_count:e.selection_coverage?.evaluated??rows.length,unknown_count:e.selection_coverage?.unknown??rows.filter(r=>r.state==='unknown').length};
}

export function inventoryReportScopeLabel(c){const op={gt:'>',gte:'>=',lt:'<',lte:'<='};return `${c.statuses.join('/')} variants · ${c.pos.names.join(' + ')} Available ${op[c.pos.operator]} ${c.pos.threshold} · ${c.online.names[0]} Available ${op[c.online.operator]} ${c.online.threshold} · exclude exact tags: ${c.excluded_tags.join(', ')||'none'}`;}

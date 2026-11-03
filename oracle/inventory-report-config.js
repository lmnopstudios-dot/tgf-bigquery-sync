// Governed variant inventory predicates. No title matching, Shopify writes or
// store IDs inferred from names. Names are bound to native locations at read time.
const fail=()=>Object.assign(new Error('Invalid inventory report filters'),{code:'INVALID_INVENTORY_REPORT'});
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
export function filteredInventoryScope(message){
 const text=String(message||'').replace(/[*`“”]/g,'').trim();
 if(!/\b(?:variants?|products?)\b/i.test(text)||!/\bavailable(?:\s+stock|\s+inventory)?\s*(?:>=|<=|>|<)/i.test(text))return null;
 const groups=[...text.matchAll(/(?:\bwhere\s+|\band\s+|[,;\n]\s*|^)([A-Za-z][A-Za-z0-9 '\-+]*?)\s+available(?:\s+(?:stock|inventory))?\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)/gi)].map(m=>({names:m[1].replace(/^.*?\bwhere\s+/i,'').replace(/^and\s+/i,'').split('+').map(clean),operator:operators[m[2]],threshold:Number(m[3])}));
 // A sum of POS locations and a separate single-location quantity. Other
 // expressions must not silently become an unfiltered or capped stock lookup.
 if(groups.length!==2)throw fail();
 const pos=groups.find(g=>g.names.length>1),online=groups.find(g=>g!==pos);if(!pos||!online||online.names.length!==1)throw fail();
 let requested=['ACTIVE','DRAFT','UNLISTED'];
 if(/\bactive\s+(?:Shopify\s+)?(?:variants|products)\b/i.test(text))requested=['ACTIVE'];
 if(/\bactive\s+and\s+draft\s+(?:variants|products)\b/i.test(text))requested=['ACTIVE','DRAFT'];
 for(const clause of text.split(/[.!;\n]/))if(/\bexclud(?:e|ing)\b/i.test(clause)&&/\b(?:draft|unlisted|archived)\b/i.test(clause))requested=requested.filter(s=>!new RegExp(`\\b${s}\\b`,'i').test(clause));
 const tags=[...text.matchAll(/\b(?:exclude|excluding|without)\s+(?:the\s+)?(?:exact\s+)?["']?([\w-]+)["']?\s+tags?\b/gi)].map(m=>m[1]);
 if(/\binclude\s+made[- ]to[- ]order\b/i.test(text)&&tags.some(t=>t.toLowerCase()==='made-to-order'))throw fail();
 const config=validateInventoryReportConfig({version:1,statuses:requested,excluded_tags:tags,pos,online,exclude_workshops:/\bexclude\s+(?:the\s+)?workshops?\b/i.test(text),require_known_available:true,sort:{metric:'pos_total_available',direction:/\b(?:total\s+POS|POS\s+total)\s+asc(?:ending)?\b/i.test(text)?'asc':'desc'}});
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
 return{groups,rows,qualified:rows.filter(r=>r.state==='qualified'),unknown_count:rows.filter(r=>r.state==='unknown').length};
}

export function inventoryReportScopeLabel(c){const op={gt:'>',gte:'>=',lt:'<',lte:'<='};return `${c.statuses.join('/')} variants · ${c.pos.names.join(' + ')} Available ${op[c.pos.operator]} ${c.pos.threshold} · ${c.online.names[0]} Available ${op[c.online.operator]} ${c.online.threshold} · exclude exact tags: ${c.excluded_tags.join(', ')||'none'}`;}

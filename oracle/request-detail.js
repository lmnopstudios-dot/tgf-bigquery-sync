// Calculation detail is independent of retained population and delivery format.
// Monetary bounds are lower inclusive / upper exclusive in minor units.
export function validateRequestDetail(value){
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value))throw Error('Invalid requested detail');
  const {level='aggregate',subset=null,bands=null,overlap=null,formats=[],grouping='main_remaining_products',ranking='orders_desc',limit=20,comparison_scope='population'}=value;
  const amount=n=>Number.isSafeInteger(n)&&n>=0;
  if(!['population','subset'].includes(comparison_scope))throw Error('Invalid comparison scope');
  if(grouping!=='main_remaining_products'||ranking!=='orders_desc'||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid detail grouping or ranking');
  if(!['aggregate','detail','underlying'].includes(level)||!Array.isArray(formats)||formats.some(f=>!['chart','xlsx'].includes(f)))throw Error('Invalid requested detail');
  if(subset&&(!amount(subset.highest_below)||!amount(subset.total_at_least)||typeof subset.exclude_sale!=='boolean'))throw Error('Invalid subset');
  if(bands&&(!Array.isArray(bands)||!bands.length||bands.length>100||bands.some((b,i)=>!amount(b.lower)||b.upper!==null&&(!amount(b.upper)||b.upper<=b.lower)||i&&(bands[i-1].upper===null||b.lower<bands[i-1].upper))))throw Error('Invalid requested bands');
  if(overlap&&(!amount(overlap.lower)||!amount(overlap.upper)||overlap.upper<=overlap.lower))throw Error('Invalid overlap');
  return {level,grouping,ranking,limit,comparison_scope,subset:subset?{highest_below:subset.highest_below,total_at_least:subset.total_at_least,exclude_sale:subset.exclude_sale}:null,bands:bands?.map(b=>({lower:b.lower,upper:b.upper}))||null,overlap:overlap?{lower:overlap.lower,upper:overlap.upper}:null,formats:[...new Set(formats)]};
}
export function requestDetailPatch(previous,text){
  const p=previous||{},minor=s=>{if(!/^\d+(?:\.\d{1,2}0*)?$/.test(s))throw Error('Invalid monetary boundary');const n=Math.round(Number(s)*100);if(!Number.isSafeInteger(n))throw Error('Invalid monetary boundary');return n;},bands=[];
  const bandText=text.replace(/highest[^.;\n]*?(?:worth|of|at|priced)\s*£\s*\d+(?:\.\d+)?\s*[–—-]\s*£?\s*\d+(?:\.\d+)?/gi,'');
  for(const m of bandText.matchAll(/£\s*(\d+(?:\.\d+)?)\s*[–—-]\s*£?\s*(\d+(?:\.\d+)?)/g))bands.push({lower:minor(m[1]),upper:minor(m[2])+1});
  const plus=bandText.match(/£\s*(\d+(?:\.\d+)?)\s*\+/);if(plus)bands.push({lower:minor(plus[1]),upper:null});
  // A highest-unit interval is a predicate, not a basket-total display band.
  const overlap=text.match(/highest[^.;\n]{0,80}?(?:worth|of|at|priced)\s*£\s*(\d+(?:\.\d+)?)\s*[–—-]\s*£?\s*(\d+(?:\.\d+)?)/i);
  for(const m of bandText.matchAll(/\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?|infinity|∞)\s*\)/gi))bands.push({lower:minor(m[1]),upper:/infinity|∞/i.test(m[2])?null:minor(m[2])});
  const explicitOverlap=text.match(/highest[^.;\n]*?>=\s*£?(\d+(?:\.\d+)?)\s+AND\s*<\s*£?(\d+(?:\.\d+)?)/i);
  const total=text.match(/merchandise subtotal\s*>=\s*£?(\d+(?:\.\d+)?)/i);
  const highest=text.match(/highest[^.;\n]*?unit price\s*<\s*£?(\d+(?:\.\d+)?)/i);
  const reached=text.match(/(?:reached|reach|at least)\s*£\s*(\d+(?:\.\d+)?)/i),below=text.match(/(?:below|under)\s*£\s*(\d+(?:\.\d+)?)/i);
  const narrowing=Boolean(total&&highest)||/no individual item (?:reached|reach)\s*£/i.test(text)||/only through multiple items|highest[^.;\n]{0,80}(?:below|under)\s*£/i.test(text);
  const t=minor(total?.[1]||reached?.[1]||below?.[1]||250);
  const level=/underlying|anonymous basket reference|row[ -]level/i.test(text)?'underlying':bands.length||/most common|supporting detail/i.test(text)?'detail':/\baggregates?\b/i.test(text)?'aggregate':p.level||'aggregate';
  const top=text.match(/\btop\s+(\d+)\s+(?:combinations|products)/i);
  return validateRequestDetail({comparison_scope:p.subset&&/aggregates? only|summari[sz]e[^.;]{0,40}(?:subset|those)|aggregate[^.;]{0,30}subset/i.test(text)?'subset':p.comparison_scope,grouping:p.grouping,ranking:p.ranking,limit:top?Number(top[1]):p.limit,level:/compact comparison table|supporting combinations.*Show details/i.test(text)?'aggregate':level,subset:narrowing?{highest_below:minor(highest?.[1]||below?.[1]||reached?.[1]||250),total_at_least:t,exclude_sale:/sale[ -]excluded|exclud/i.test(text)}:p.subset||null,bands:bands.length?bands.sort((a,b)=>a.lower-b.lower):p.bands||null,overlap:explicitOverlap?{lower:minor(explicitOverlap[1]),upper:minor(explicitOverlap[2])}:overlap?{lower:minor(overlap[1]),upper:minor(overlap[2])+1}:p.overlap||null,formats:[...new Set([...(p.formats||[]),...(/charts?|graphs?/i.test(text)?['chart']:[]),...(/export|xlsx|excel|download/i.test(text)?['xlsx']:[])])]});
}

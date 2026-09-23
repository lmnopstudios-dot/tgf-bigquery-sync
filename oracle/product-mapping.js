import crypto from 'node:crypto';

export const PRODUCT_MAPPING_DATASET = 'commerce';
export const PRODUCT_MAPPING_TABLE = 'product_mapping_decisions';
export const CANDIDATE_STATUSES = Object.freeze(['suggested', 'approved', 'rejected', 'superseded']);

const words = value => String(value || '').normalize('NFKC').toLocaleLowerCase('en')
  .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
const pairKey = (a, b) => [a, b].sort().join('\u0000');
const namespace = product => `${product.source_platform}:${product.source_store}`;
const ALLOWED_NAMESPACE_PAIRS = new Set([
  'shopify:shopify|woo:ww', 'shopify:shopify|woo:usd', 'shopify:shopify|square:square',
  'square:square|woo:ww', 'square:square|woo:usd', 'woo:usd|woo:ww'
]);
const COMMON_BLOCK_TOKENS = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'with', 'ring', 'rings', 'band', 'bands', 'pendant', 'bracelet', 'earring', 'earrings', 'chain']);

export function classifyProduct(title, { source_product_id } = {}) {
  const value = String(title || '').trim().toLocaleLowerCase('en');
  if (/^(uk|international|worldwide)?\s*(postage|shipping)(\s|$)/.test(value)) return 'shipping';
  if (/^(resize|repair|engraving)(\s|$)/.test(value)) return 'service';
  if (/gift\s*(voucher|card)/.test(value)) return 'gift_voucher';
  if ((!source_product_id || source_product_id === 'unknown') && /^(custom|misc|unidentified)(\s|$)/.test(value)) return 'custom_item';
  return value ? 'merchandise_product' : 'unresolved';
}

function similarity(left, right) {
  const a = words(left), b = words(right), as = new Set(a), bs = new Set(b);
  const shared = [...as].filter(x => bs.has(x));
  const union = new Set([...a, ...b]).size;
  const jaccard = union ? shared.length / union : 0;
  const containment = Math.min(as.size, bs.size) ? shared.length / Math.min(as.size, bs.size) : 0;
  const unmatchedLeft = [...as].filter(x => !bs.has(x)), unmatchedRight = [...bs].filter(x => !as.has(x));
  return { score: Math.round((jaccard * .55 + containment * .45) * 1000) / 1000, shared, token_containment: containment, unmatchedLeft, unmatchedRight, equivalent: a.join(' ') === b.join(' ') };
}

/** Suggestions are review queues only; this function never returns graph edges. */
export function generateMappingCandidates(products, { decisions = [], minimumScore = .48, diagnostics = null } = {}) {
  const decided = new Map(decisions.map(d => [pairKey(d.left_ref, d.right_ref), d.status]));
  const governedRefs=new Set(decisions.filter(d=>d.status==='approved').flatMap(d=>[d.left_ref,d.right_ref]));
  const eligible = products.filter(p => p.mapping_status !== 'resolved' && !governedRefs.has(p.source_product_ref) && classifyProduct(p.title, p) === 'merchandise_product');
  const tokenFrequency = new Map(), blocks = new Map();
  for (const product of eligible) for (const token of new Set(words(product.title))) tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
  const addBlock = (key, index) => { if (!key) return; const values=blocks.get(key)||[]; values.push(index); blocks.set(key,values); };
  eligible.forEach((product,index) => {
    const tokens=[...new Set(words(product.title))];
    for(const token of tokens) if(!COMMON_BLOCK_TOKENS.has(token) && token.length >= 3 && tokenFrequency.get(token) <= 20) addBlock(`t:${token}`,index);
    addBlock(`p:${tokens.filter(t=>!COMMON_BLOCK_TOKENS.has(t)).slice(0,2).join(':')}`,index);
    if(String(product.sku||'').trim()) addBlock(`s:${String(product.sku).trim().toUpperCase()}`,index);
  });
  const blocked = new Set();
  for(const indexes of blocks.values()) for(let a=0;a<indexes.length;a++) for(let b=a+1;b<indexes.length;b++) blocked.add(`${Math.min(indexes[a],indexes[b])}:${Math.max(indexes[a],indexes[b])}`);
  const candidates = []; let considered=0, beforeThreshold=0;
  for (const blockedPair of blocked) {
    const [i,j]=blockedPair.split(':').map(Number), left = eligible[i], right = eligible[j];
    if (namespace(left) === namespace(right) || !ALLOWED_NAMESPACE_PAIRS.has([namespace(left),namespace(right)].sort().join('|'))) continue;
    considered++;
    const key = pairKey(left.source_product_ref, right.source_product_ref);
    if (['rejected', 'approved', 'superseded'].includes(decided.get(key))) continue;
    const evidence = similarity(left.title, right.title);
    const sku = String(left.sku || '').trim() && String(left.sku).trim().toUpperCase() === String(right.sku || '').trim().toUpperCase();
    const ready = /^ready\s+to\s+ship\b/i.test(left.title || '') || /^ready\s+to\s+ship\b/i.test(right.title || '');
    const score = Math.min(1, evidence.equivalent ? 1 : evidence.score + (sku ? .3 : 0) + (ready && evidence.token_containment >= .5 ? .08 : 0));
    beforeThreshold++;
    if (score < minimumScore) continue;
    const confidence = score >= .9 ? 'high' : score >= .64 ? 'medium' : 'low';
    const line_items = Number(left.line_items || 0) + Number(right.line_items || 0);
    const sales = Number(left.sales || 0) + Number(right.sales || 0);
    const reasons=[];
    if(evidence.equivalent) reasons.push('and/& and punctuation normalization produces equivalent title');
    if(evidence.shared.length) reasons.push(`${evidence.shared.length} of ${Math.max(words(left.title).length,words(right.title).length)} significant title tokens shared`);
    if(evidence.token_containment===1 && !evidence.equivalent) reasons.push('one normalized title is contained within the other');
    if(sku) reasons.push('exact source SKU');
    const unmatched=[...evidence.unmatchedLeft,...evidence.unmatchedRight]; if(unmatched.length) reasons.push(`${unmatched.length===1?'one additional unmatched token':'unmatched tokens'}: ${unmatched.join(', ')}`);
    candidates.push({ candidate_id: crypto.createHash('sha256').update(key).digest('hex').slice(0, 24), left_source:namespace(left), right_source:namespace(right), left_ref:left.source_product_ref, right_ref:right.source_product_ref, left_title:left.title, right_title:right.title, suggested_canonical_title:String(left.title).length <= String(right.title).length ? left.title : right.title, candidate_method:'blocked_normalized_token_similarity', candidate_evidence:{ summary:reasons, shared_tokens:evidence.shared, unmatched_tokens:unmatched, token_score:evidence.score, exact_sku:Boolean(sku), ready_to_ship_prefix:Boolean(ready) }, score, confidence, review_priority:confidence, status:'suggested', line_items, sales, competing:false, competing_candidates:false });
  }
  const refs = new Map();
  for (const c of candidates) for (const ref of [c.left_ref,c.right_ref]) refs.set(ref,(refs.get(ref)||0)+1);
  for (const c of candidates) c.competing = c.competing_candidates = refs.get(c.left_ref)>1 || refs.get(c.right_ref)>1;
  if(diagnostics) Object.assign(diagnostics,{eligible_products:eligible.length,eligible_by_source:Object.fromEntries([...new Set(eligible.map(namespace))].sort().map(ns=>[ns,eligible.filter(p=>namespace(p)===ns).length])),blocked_candidate_pairs_considered:considered,candidates_before_scoring_threshold:beforeThreshold,candidates_after_threshold:candidates.length});
  return candidates.sort((a,b) => b.sales-a.sales || b.line_items-a.line_items || b.score-a.score || a.candidate_id.localeCompare(b.candidate_id));
}

export function approvedMappingEdges(decisions) {
  return decisions.filter(x => x.status === 'approved').map(x => ({ left_ref:x.left_ref, right_ref:x.right_ref, mapping_method:'explicit_governed_mapping', mapping_status:'resolved', approved_by:x.reviewed_by, approved_at:x.reviewed_at, provenance:x.provenance, note:x.note || null }));
}

export function candidateDiagnostics(products, decisions = [], options = {}) {
  const generation = {}, candidates = generateMappingCandidates(products,{...options,decisions,diagnostics:generation});
  const governedRefs=new Set(decisions.filter(d=>d.status==='approved').flatMap(d=>[d.left_ref,d.right_ref]));
  const eligible=products.filter(p=>p.mapping_status!=='resolved'&&!governedRefs.has(p.source_product_ref)&&classifyProduct(p.title,p)==='merchandise_product');
  const represented=new Set(candidates.flatMap(c=>[c.left_ref,c.right_ref])), covered=eligible.filter(p=>represented.has(p.source_product_ref));
  const lines=eligible.reduce((n,p)=>n+Number(p.line_items||0),0), sales=eligible.reduce((n,p)=>n+Number(p.sales||0),0);
  const latest=[...new Map(decisions.map(d=>[d.candidate_id,d])).values()];
  return {...generation,candidate_count:candidates.length,high_review_priority:candidates.filter(c=>c.confidence==='high').length,medium_review_priority:candidates.filter(c=>c.confidence==='medium').length,low_review_priority:candidates.filter(c=>c.confidence==='low').length,unique_source_products_represented:represented.size,competing_candidate_count:candidates.filter(c=>c.competing_candidates).length,candidate_line_item_coverage:lines?covered.reduce((n,p)=>n+Number(p.line_items||0),0)/lines:0,candidate_sales_coverage:sales?covered.reduce((n,p)=>n+Number(p.sales||0),0)/sales:0,approved_count:latest.filter(d=>d.status==='approved').length,rejected_count:latest.filter(d=>d.status==='rejected').length,top_candidates:candidates.slice(0,20).map(c=>({source_a:c.left_source,product_ref_a:c.left_ref,title_a:c.left_title,source_b:c.right_source,product_ref_b:c.right_ref,title_b:c.right_title,review_priority:c.review_priority,evidence_summary:c.candidate_evidence.summary,line_item_impact:c.line_items,sales_impact:c.sales,competing_candidates:c.competing_candidates}))};
}

export function validateGraphApproval(candidate, approvedEdges = []) {
  if (!candidate?.left_ref || !candidate?.right_ref || candidate.left_ref === candidate.right_ref) throw new Error('invalid product mapping pair');
  const namespace = ref => ref.split(':').slice(0,2).join(':');
  const adjacency = new Map();
  for (const edge of approvedEdges) { (adjacency.get(edge.left_ref) || adjacency.set(edge.left_ref,[]).get(edge.left_ref)).push(edge.right_ref); (adjacency.get(edge.right_ref) || adjacency.set(edge.right_ref,[]).get(edge.right_ref)).push(edge.left_ref); }
  (adjacency.get(candidate.left_ref) || adjacency.set(candidate.left_ref,[]).get(candidate.left_ref)).push(candidate.right_ref);
  (adjacency.get(candidate.right_ref) || adjacency.set(candidate.right_ref,[]).get(candidate.right_ref)).push(candidate.left_ref);
  const component = new Set([candidate.left_ref]), queue=[candidate.left_ref];
  while(queue.length) for(const next of adjacency.get(queue.shift())||[]) if(!component.has(next)){component.add(next);queue.push(next);}
  const seen = new Set(); for (const ref of component) { const ns=namespace(ref); if(seen.has(ns)) throw new Error(`mapping would create a canonical graph conflict in ${ns}`); seen.add(ns); }
  return true;
}

export function createProductMappingService({ bigquery, project, dataset = PRODUCT_MAPPING_DATASET }) {
  const table = `${project}.${dataset}.${PRODUCT_MAPPING_TABLE}`;
  const setup = async () => { const ds=bigquery.dataset(dataset); const [exists]=await ds.exists(); if(!exists) await ds.create({location:'EU',labels:{component:'product_identity'}}); const target=ds.table(PRODUCT_MAPPING_TABLE); const [found]=await target.exists(); if(!found) await target.create({schema:{fields:['event_id:STRING','candidate_id:STRING','left_ref:STRING','right_ref:STRING','left_title:STRING','right_title:STRING','suggested_canonical_title:STRING','candidate_method:STRING','candidate_evidence:JSON','score:FLOAT','confidence:STRING','status:STRING','mapping_method:STRING','reviewed_by:STRING','reviewed_at:TIMESTAMP','provenance:STRING','note:STRING'].map(spec=>{const [name,type]=spec.split(':');return {name,type};})},timePartitioning:{type:'DAY',field:'reviewed_at'},labels:{component:'product_identity'}}); };
  const decisions = async () => { const [rows] = await bigquery.query({ query:`SELECT * EXCEPT(rank) FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY candidate_id ORDER BY reviewed_at DESC) rank FROM \`${table}\`) WHERE rank=1`, useLegacySql:false }); return rows; };
  const loadProducts = async () => { const [rows]=await bigquery.query({query:`WITH lines AS (SELECT 'woo' source_platform,'ww' source_store,CAST(product_id AS STRING) source_product_id,name title,sku,quantity units,total sales FROM \`${project}.metorik_uk.order_line_items\` UNION ALL SELECT 'woo','usd',CAST(product_id AS STRING),name,sku,quantity,total FROM \`${project}.metorik_us.order_line_items\` UNION ALL SELECT 'shopify','shopify',li.product_id,COALESCE(li.title,li.name),li.sku,li.quantity,li.discounted_total_presentment FROM \`${project}.shopify_data.order_line_items\` li JOIN \`${project}.shopify_data.order_locations\` l USING(order_id) WHERE l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145' UNION ALL SELECT 'square','square',COALESCE(JSON_VALUE(SAFE.PARSE_JSON(transaction_line_item_json),'$.item_id'),catalog_object_id),transaction_item_name,transaction_sku,quantity,total_amount FROM \`${project}.square_data.retail_order_items\`), ranked AS (SELECT *,COUNT(*) OVER(PARTITION BY source_platform,source_store,source_product_id,title) title_lines FROM lines), products AS (SELECT source_platform,source_store,source_product_id,CONCAT(source_platform,':',source_store,':',source_product_id) source_product_ref,ARRAY_AGG(STRUCT(title,title_lines) ORDER BY title_lines DESC,title LIMIT 1)[OFFSET(0)].title title,ARRAY_AGG(NULLIF(sku,'') IGNORE NULLS LIMIT 1)[SAFE_OFFSET(0)] sku,COUNT(*) line_items,SUM(sales) sales FROM ranked GROUP BY 1,2,3) , normalized AS (SELECT *,LOWER(TRIM(REGEXP_REPLACE(NORMALIZE(title,NFKC),r'\\s+',' '))) exact_title,NULLIF(UPPER(TRIM(sku)),'') exact_sku FROM products), keyed AS (SELECT *,COUNT(*) OVER(PARTITION BY source_platform,source_store,exact_title) local_title_count,COUNT(DISTINCT CONCAT(source_platform,':',source_store)) OVER(PARTITION BY exact_title) title_sources,COUNT(*) OVER(PARTITION BY source_platform,source_store,exact_sku) local_sku_count,COUNT(DISTINCT CONCAT(source_platform,':',source_store)) OVER(PARTITION BY exact_sku) sku_sources FROM normalized) SELECT * EXCEPT(exact_title,exact_sku,local_title_count,title_sources,local_sku_count,sku_sources),IF((exact_sku IS NOT NULL AND local_sku_count=1 AND sku_sources>1) OR (exact_title!='' AND local_title_count=1 AND title_sources>1),'resolved','source_specific') mapping_status FROM keyed`,useLegacySql:false,maximumBytesBilled:'10000000000'}); return rows; };
  return {
    setup,
    async list({ products, search = '' } = {}) { await setup(); const history=await decisions(); const items=generateMappingCandidates(products || await loadProducts(),{decisions:history}).filter(x=>!search || `${x.left_title} ${x.right_title}`.toLowerCase().includes(search.toLowerCase())).slice(0,250); return { items, summary:`I found ${items.filter(x=>x.confidence==='high').length} high-confidence unresolved product mappings that could improve historical product comparison.` }; },
    async review(candidate, status, reviewer, note=null) { await setup(); if (!['approved','rejected'].includes(status)) throw new Error('status must be approved or rejected'); const history=await decisions(); if(status==='approved') validateGraphApproval(candidate,approvedMappingEdges(history)); const row={ event_id:crypto.randomUUID(), candidate_id:candidate.candidate_id, left_ref:candidate.left_ref, right_ref:candidate.right_ref, left_title:candidate.left_title, right_title:candidate.right_title, suggested_canonical_title:candidate.suggested_canonical_title, candidate_method:candidate.candidate_method, candidate_evidence:JSON.stringify(candidate.candidate_evidence||{}), score:Number(candidate.score), confidence:candidate.confidence, status, mapping_method:status==='approved'?'explicit_governed_mapping':null, reviewed_by:reviewer, reviewed_at:new Date().toISOString(), provenance:'oracle_product_mapping_review', note }; await bigquery.dataset(dataset).table(PRODUCT_MAPPING_TABLE).insert([row]); return row; },
    decisions
  };
}

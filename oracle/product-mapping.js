import crypto from 'node:crypto';

export const PRODUCT_MAPPING_DATASET = 'commerce';
export const PRODUCT_MAPPING_TABLE = 'product_mapping_decisions';
export const CANDIDATE_STATUSES = Object.freeze(['suggested', 'approved', 'rejected', 'superseded']);

const words = value => String(value || '').normalize('NFKC').toLocaleLowerCase('en')
  .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
const pairKey = (a, b) => [a, b].sort().join('\u0000');

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
  return { score: Math.round((jaccard * .55 + containment * .45) * 1000) / 1000, shared, token_containment: containment };
}

/** Suggestions are review queues only; this function never returns graph edges. */
export function generateMappingCandidates(products, { decisions = [], minimumScore = .48 } = {}) {
  const decided = new Map(decisions.map(d => [pairKey(d.left_ref, d.right_ref), d.status]));
  const candidates = [];
  for (let i = 0; i < products.length; i++) for (let j = i + 1; j < products.length; j++) {
    const left = products[i], right = products[j];
    if (`${left.source_platform}:${left.source_store}` === `${right.source_platform}:${right.source_store}`) continue;
    if (classifyProduct(left.title, left) !== 'merchandise_product' || classifyProduct(right.title, right) !== 'merchandise_product') continue;
    const key = pairKey(left.source_product_ref, right.source_product_ref);
    if (['rejected', 'approved', 'superseded'].includes(decided.get(key))) continue;
    const evidence = similarity(left.title, right.title);
    const sku = String(left.sku || '').trim() && String(left.sku).trim().toUpperCase() === String(right.sku || '').trim().toUpperCase();
    const ready = /^ready\s+to\s+ship\b/i.test(left.title || '') || /^ready\s+to\s+ship\b/i.test(right.title || '');
    const score = Math.min(1, evidence.score + (sku ? .3 : 0) + (ready && evidence.token_containment >= .5 ? .08 : 0));
    if (score < minimumScore) continue;
    const confidence = score >= .82 ? 'high' : score >= .64 ? 'medium' : 'low';
    const line_items = Number(left.line_items || 0) + Number(right.line_items || 0);
    const sales = Number(left.sales || 0) + Number(right.sales || 0);
    candidates.push({ candidate_id: crypto.createHash('sha256').update(key).digest('hex').slice(0, 24), left_ref:left.source_product_ref, right_ref:right.source_product_ref, left_title:left.title, right_title:right.title, suggested_canonical_title:String(left.title).length <= String(right.title).length ? left.title : right.title, candidate_method:'normalized_token_similarity', candidate_evidence:{ shared_tokens:evidence.shared, token_score:evidence.score, exact_sku:Boolean(sku), ready_to_ship_prefix:Boolean(ready) }, score, confidence, status:'suggested', line_items, sales, competing:false });
  }
  const refs = new Map();
  for (const c of candidates) for (const ref of [c.left_ref,c.right_ref]) refs.set(ref,(refs.get(ref)||0)+1);
  for (const c of candidates) c.competing = refs.get(c.left_ref)>1 || refs.get(c.right_ref)>1;
  return candidates.sort((a,b) => b.sales-a.sales || b.line_items-a.line_items || b.score-a.score || a.candidate_id.localeCompare(b.candidate_id));
}

export function approvedMappingEdges(decisions) {
  return decisions.filter(x => x.status === 'approved').map(x => ({ left_ref:x.left_ref, right_ref:x.right_ref, mapping_method:'explicit_governed_mapping', mapping_status:'resolved', approved_by:x.reviewed_by, approved_at:x.reviewed_at, provenance:x.provenance, note:x.note || null }));
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
  const loadProducts = async () => { const [rows]=await bigquery.query({query:`WITH lines AS (SELECT 'woo' source_platform,'ww' source_store,CAST(product_id AS STRING) source_product_id,name title,sku,quantity units,total sales FROM \`${project}.metorik_uk.order_line_items\` UNION ALL SELECT 'woo','usd',CAST(product_id AS STRING),name,sku,quantity,total FROM \`${project}.metorik_us.order_line_items\` UNION ALL SELECT 'shopify','shopify',li.product_id,COALESCE(li.title,li.name),li.sku,li.quantity,li.discounted_total_presentment FROM \`${project}.shopify_data.order_line_items\` li JOIN \`${project}.shopify_data.order_locations\` l USING(order_id) WHERE l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145' UNION ALL SELECT 'square','square',COALESCE(JSON_VALUE(SAFE.PARSE_JSON(transaction_line_item_json),'$.item_id'),catalog_object_id),transaction_item_name,transaction_sku,quantity,total_amount FROM \`${project}.square_data.retail_order_items\`), ranked AS (SELECT *,COUNT(*) OVER(PARTITION BY source_platform,source_store,source_product_id,title) title_lines FROM lines), products AS (SELECT source_platform,source_store,source_product_id,CONCAT(source_platform,':',source_store,':',source_product_id) source_product_ref,ARRAY_AGG(STRUCT(title,title_lines) ORDER BY title_lines DESC,title LIMIT 1)[OFFSET(0)].title title,ARRAY_AGG(NULLIF(sku,'') IGNORE NULLS LIMIT 1)[SAFE_OFFSET(0)] sku,COUNT(*) line_items,SUM(sales) sales FROM ranked GROUP BY 1,2,3) SELECT * FROM products`,useLegacySql:false,maximumBytesBilled:'10000000000'}); return rows; };
  return {
    setup,
    async list({ products, search = '' } = {}) { await setup(); const history=await decisions(); const items=generateMappingCandidates(products || await loadProducts(),{decisions:history}).filter(x=>!search || `${x.left_title} ${x.right_title}`.toLowerCase().includes(search.toLowerCase())).slice(0,250); return { items, summary:`I found ${items.filter(x=>x.confidence==='high').length} high-confidence unresolved product mappings that could improve historical product comparison.` }; },
    async review(candidate, status, reviewer, note=null) { await setup(); if (!['approved','rejected'].includes(status)) throw new Error('status must be approved or rejected'); const history=await decisions(); if(status==='approved') validateGraphApproval(candidate,approvedMappingEdges(history)); const row={ event_id:crypto.randomUUID(), candidate_id:candidate.candidate_id, left_ref:candidate.left_ref, right_ref:candidate.right_ref, left_title:candidate.left_title, right_title:candidate.right_title, suggested_canonical_title:candidate.suggested_canonical_title, candidate_method:candidate.candidate_method, candidate_evidence:JSON.stringify(candidate.candidate_evidence||{}), score:Number(candidate.score), confidence:candidate.confidence, status, mapping_method:status==='approved'?'explicit_governed_mapping':null, reviewed_by:reviewer, reviewed_at:new Date().toISOString(), provenance:'oracle_product_mapping_review', note }; await bigquery.dataset(dataset).table(PRODUCT_MAPPING_TABLE).insert([row]); return row; },
    decisions
  };
}

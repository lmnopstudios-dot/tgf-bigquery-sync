import crypto from 'node:crypto';
import { assertProductGraphIntegrity, diagnoseExistingProductConflicts, diagnoseProposedProductEdge, inspectProductGraph } from './product-graph-integrity.js';
import { mapProductPair } from './product-identity.js';
import { atGovernanceStage } from './governance-diagnostics.js';

export const PRODUCT_MAPPING_DATASET = 'commerce';
export const PRODUCT_MAPPING_TABLE = 'product_mapping_decisions';
export const CANDIDATE_STATUSES = Object.freeze(['suggested', 'approved', 'rejected', 'revoked', 'superseded', 'reconsidered']);
export const MAX_REVIEW_NOTE_LENGTH = 500;
export const PRODUCT_MAPPING_SCHEMA=Object.freeze(['event_id:STRING','decision_id:STRING','relationship_id:STRING','candidate_id:STRING','left_ref:STRING','right_ref:STRING','left_title:STRING','right_title:STRING','suggested_canonical_title:STRING','candidate_method:STRING','candidate_evidence:JSON','score:FLOAT64','confidence:STRING','status:STRING','mapping_method:STRING','reviewed_by:STRING','reviewed_at:TIMESTAMP','provenance:STRING','note:STRING','supersedes_decision_id:STRING','replacement_for_decision_id:STRING']);

const words = value => String(value || '').normalize('NFKC').toLocaleLowerCase('en')
  .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
const pairKey = (a, b) => [a, b].sort().join('\u0000');
export const relationshipId = (a, b) => crypto.createHash('sha256').update(pairKey(a, b)).digest('hex').slice(0, 24);
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
  const state=resolveMappingDecisions(decisions);
  const decided = new Map(state.current.map(d => [pairKey(d.left_ref, d.right_ref), d.status]));
  const governedRefs=new Set(state.activeApproved.flatMap(d=>[d.left_ref,d.right_ref]));
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
    if (['rejected', 'approved', 'revoked', 'superseded'].includes(decided.get(key))) continue;
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
  return resolveMappingDecisions(decisions).activeApproved.map(x => ({ left_ref:x.left_ref, right_ref:x.right_ref, decision_id:x.decision_id || x.event_id, mapping_method:'explicit_governed_mapping', mapping_status:'resolved', approved_by:x.reviewed_by, approved_at:x.reviewed_at, provenance:x.provenance, note:x.note || null }));
}

export function deterministicMappingEdges(products) {
  const groups=new Map();for(const product of products){const ns=namespace(product);if(!groups.has(ns))groups.set(ns,[]);groups.get(ns).push(product);}
  const namespaces=[...groups].sort(([a],[b])=>a.localeCompare(b)),edges=[];
  for(let i=0;i<namespaces.length;i++)for(let j=i+1;j<namespaces.length;j++)edges.push(...mapProductPair(namespaces[i][1],namespaces[j][1]));
  return edges;
}

/** The sole in-process current-state resolver. Supersession links win over timestamps. */
export function resolveMappingDecisions(history = []) {
  const ordered=[...history].sort((a,b)=>String(a.reviewed_at||'').localeCompare(String(b.reviewed_at||''))||String(a.decision_id||a.event_id||'').localeCompare(String(b.decision_id||b.event_id||'')));
  const byId=new Map(ordered.map(d=>[d.decision_id||d.event_id,d]));
  const superseded=new Set(ordered.map(d=>d.supersedes_decision_id).filter(Boolean));
  const currentByRelationship=new Map();
  for(const decision of ordered) {
    const id=decision.decision_id||decision.event_id;
    if(superseded.has(id)) continue;
    currentByRelationship.set(decision.relationship_id||relationshipId(decision.left_ref,decision.right_ref),decision);
  }
  const current=[...currentByRelationship.values()];
  return { history:ordered, byId, current, activeApproved:current.filter(d=>d.status==='approved'), activeRejected:current.filter(d=>d.status==='rejected'), revoked:ordered.filter(d=>d.status==='revoked'), superseded:ordered.filter(d=>superseded.has(d.decision_id||d.event_id)||d.status==='superseded'), orphanedSupersessionLinks:ordered.filter(d=>d.supersedes_decision_id&&!byId.has(d.supersedes_decision_id)) };
}

export function sanitizeReviewerNote(note) {
  if(note==null||String(note).trim()==='') return null;
  return String(note).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,MAX_REVIEW_NOTE_LENGTH);
}

/** Shared BigQuery form of the governed resolver used by reports and validators. */
export function governedDecisionCtes(project, prefix='governed') {
  return `${prefix}_history AS (SELECT *,COALESCE(decision_id,event_id) resolved_decision_id,COALESCE(relationship_id,candidate_id) resolved_relationship_id FROM \`${project}.${PRODUCT_MAPPING_DATASET}.${PRODUCT_MAPPING_TABLE}\`), ${prefix}_superseded AS (SELECT supersedes_decision_id decision_id FROM ${prefix}_history WHERE supersedes_decision_id IS NOT NULL), ${prefix}_ranked AS (SELECT h.*,ROW_NUMBER() OVER(PARTITION BY resolved_relationship_id ORDER BY reviewed_at DESC,resolved_decision_id DESC) relationship_rank FROM ${prefix}_history h LEFT JOIN ${prefix}_superseded s ON s.decision_id=h.resolved_decision_id WHERE s.decision_id IS NULL), ${prefix}_current AS (SELECT * FROM ${prefix}_ranked WHERE relationship_rank=1), ${prefix}_active AS (SELECT * FROM ${prefix}_current WHERE status='approved')`;
}

export function searchProducts(products, { query='', sources=[], excludeRef=null, limit=50, decisions=[] } = {}) {
  const q=String(query).normalize('NFKC').toLowerCase().trim();
  const allowed=new Set((Array.isArray(sources)?sources:String(sources).split(',')).filter(Boolean));
  const activeByRef=new Map();
  for(const d of resolveMappingDecisions(decisions).activeApproved) for(const ref of [d.left_ref,d.right_ref]) activeByRef.set(ref,d);
  return products.filter(p=>p.source_product_ref!==excludeRef&&(!allowed.size||allowed.has(namespace(p))||allowed.has(p.source_platform)))
    .filter(p=>!q||[p.title,p.normalized_title,p.sku,p.source_product_id].some(v=>String(v||'').toLowerCase().includes(q)))
    .sort((a,b)=>Number(b.line_items||0)-Number(a.line_items||0)||Number(b.sales||0)-Number(a.sales||0)||String(a.title).localeCompare(String(b.title)))
    .slice(0,Math.max(1,Math.min(Number(limit)||50,100))).map(p=>({...p,source:namespace(p),canonical_product:p.canonical_product_ref||null,explicit_mapping_status:activeByRef.has(p.source_product_ref)?'approved':'none'}));
}

export function candidateDiagnostics(products, decisions = [], options = {}) {
  const generation = {}, candidates = generateMappingCandidates(products,{...options,decisions,diagnostics:generation});
  const state=resolveMappingDecisions(decisions), governedRefs=new Set(state.activeApproved.flatMap(d=>[d.left_ref,d.right_ref]));
  const eligible=products.filter(p=>p.mapping_status!=='resolved'&&!governedRefs.has(p.source_product_ref)&&classifyProduct(p.title,p)==='merchandise_product');
  const represented=new Set(candidates.flatMap(c=>[c.left_ref,c.right_ref])), covered=eligible.filter(p=>represented.has(p.source_product_ref));
  const lines=eligible.reduce((n,p)=>n+Number(p.line_items||0),0), sales=eligible.reduce((n,p)=>n+Number(p.sales||0),0);
  return {...generation,candidate_count:candidates.length,high_review_priority:candidates.filter(c=>c.confidence==='high').length,medium_review_priority:candidates.filter(c=>c.confidence==='medium').length,low_review_priority:candidates.filter(c=>c.confidence==='low').length,unique_source_products_represented:represented.size,competing_candidate_count:candidates.filter(c=>c.competing_candidates).length,candidate_line_item_coverage:lines?covered.reduce((n,p)=>n+Number(p.line_items||0),0)/lines:0,candidate_sales_coverage:sales?covered.reduce((n,p)=>n+Number(p.sales||0),0)/sales:0,approved_count:state.activeApproved.length,rejected_count:state.activeRejected.length,revoked_count:state.revoked.length,superseded_count:state.superseded.length,top_candidates:candidates.slice(0,20).map(c=>({source_a:c.left_source,product_ref_a:c.left_ref,title_a:c.left_title,source_b:c.right_source,product_ref_b:c.right_ref,title_b:c.right_title,review_priority:c.review_priority,evidence_summary:c.candidate_evidence.summary,line_item_impact:c.line_items,sales_impact:c.sales,competing_candidates:c.competing_candidates}))};
}

export function validateGraphApproval(candidate, approvedEdges = []) {
  assertProductGraphIntegrity({ explicitEdges:[...approvedEdges, {...candidate, mapping_status:'resolved'}] });
  return true;
}

export function createProductMappingService({ bigquery, project, dataset = PRODUCT_MAPPING_DATASET }) {
  const table = `${project}.${dataset}.${PRODUCT_MAPPING_TABLE}`;
  const fields=PRODUCT_MAPPING_SCHEMA;
  const schemaFields=()=>fields.map(spec=>{const [name,type]=spec.split(':');return {name,type};});
  const setup = async () => atGovernanceStage('ensure_schema','product_mapping_ensure_table',async() => {
    const ds=bigquery.dataset(dataset); const [exists]=await ds.exists(); if(!exists) await ds.create({location:'EU',labels:{component:'product_identity'}});
    const target=ds.table(PRODUCT_MAPPING_TABLE); const [found]=await target.exists();
    if(!found) await target.create({schema:{fields:schemaFields()},timePartitioning:{type:'DAY',field:'reviewed_at'},labels:{component:'product_identity'}});
    else if(target.getMetadata&&target.setMetadata){const [meta]=await target.getMetadata();const current=meta.schema?.fields||[];const names=new Set(current.map(f=>f.name));const additions=schemaFields().filter(f=>!names.has(f.name));if(additions.length)await target.setMetadata({schema:{fields:[...current,...additions]}});}
  });
  const decisions = async () => atGovernanceStage('load_current_decision','product_mapping_history',async()=>{ const [rows] = await bigquery.query({ query:`SELECT * FROM \`${table}\` ORDER BY reviewed_at,COALESCE(decision_id,event_id)`, useLegacySql:false }); return rows.map(d=>({...d,decision_id:d.decision_id||d.event_id,relationship_id:d.relationship_id||relationshipId(d.left_ref,d.right_ref)})); });
  const loadProducts = async () => { const [rows]=await bigquery.query({query:`WITH lines AS (SELECT 'woo' source_platform,'ww' source_store,CAST(product_id AS STRING) source_product_id,name title,sku,quantity units,total sales FROM \`${project}.metorik_uk.order_line_items\` UNION ALL SELECT 'woo','usd',CAST(product_id AS STRING),name,sku,quantity,total FROM \`${project}.metorik_us.order_line_items\` UNION ALL SELECT 'shopify','shopify',li.product_id,COALESCE(li.title,li.name),li.sku,li.quantity,li.discounted_total_presentment FROM \`${project}.shopify_data.order_line_items\` li JOIN \`${project}.shopify_data.order_locations\` l USING(order_id) WHERE l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145' UNION ALL SELECT 'square','square',COALESCE(JSON_VALUE(SAFE.PARSE_JSON(transaction_line_item_json),'$.item_id'),catalog_object_id),transaction_item_name,transaction_sku,quantity,total_amount FROM \`${project}.square_data.retail_order_items\`), ranked AS (SELECT *,COUNT(*) OVER(PARTITION BY source_platform,source_store,source_product_id,title) title_lines FROM lines), products AS (SELECT source_platform,source_store,source_product_id,CONCAT(source_platform,':',source_store,':',source_product_id) source_product_ref,ARRAY_AGG(STRUCT(title,title_lines) ORDER BY title_lines DESC,title LIMIT 1)[OFFSET(0)].title title,ARRAY_AGG(NULLIF(sku,'') IGNORE NULLS LIMIT 1)[SAFE_OFFSET(0)] sku,COUNT(*) line_items,SUM(sales) sales FROM ranked GROUP BY 1,2,3) , normalized AS (SELECT *,LOWER(TRIM(REGEXP_REPLACE(NORMALIZE(title,NFKC),r'\\s+',' '))) normalized_title,NULLIF(UPPER(TRIM(sku)),'') exact_sku FROM products), keyed AS (SELECT *,COUNT(*) OVER(PARTITION BY source_platform,source_store,normalized_title) local_title_count,COUNT(DISTINCT CONCAT(source_platform,':',source_store)) OVER(PARTITION BY normalized_title) title_sources,COUNT(*) OVER(PARTITION BY source_platform,source_store,exact_sku) local_sku_count,COUNT(DISTINCT CONCAT(source_platform,':',source_store)) OVER(PARTITION BY exact_sku) sku_sources FROM normalized) SELECT * EXCEPT(exact_sku,local_title_count,title_sources,local_sku_count,sku_sources),IF((exact_sku IS NOT NULL AND local_sku_count=1 AND sku_sources>1) OR (normalized_title!='' AND local_title_count=1 AND title_sources>1),'resolved','source_specific') mapping_status FROM keyed`,useLegacySql:false,maximumBytesBilled:'10000000000'}); return rows; };
  const makeDecision=(pair,status,reviewer,{note=null,provenance='oracle_product_mapping_review',supersedes=null,replacementFor=null}={})=>{const decision_id=crypto.randomUUID();return {event_id:decision_id,decision_id,relationship_id:relationshipId(pair.left_ref,pair.right_ref),candidate_id:pair.candidate_id||relationshipId(pair.left_ref,pair.right_ref),left_ref:pair.left_ref,right_ref:pair.right_ref,left_title:pair.left_title||null,right_title:pair.right_title||null,suggested_canonical_title:pair.suggested_canonical_title||null,candidate_method:pair.candidate_method||'human_selected',candidate_evidence:pair.candidate_evidence||{},score:Number(pair.score||0),confidence:pair.confidence||null,status,mapping_method:status==='approved'?'explicit_governed_mapping':null,reviewed_by:reviewer,reviewed_at:new Date().toISOString(),provenance,note:sanitizeReviewerNote(note),supersedes_decision_id:supersedes,replacement_for_decision_id:replacementFor};};
  // One DML statement is atomic in BigQuery: a correction can never retain only
  // its rejection or only its replacement approval.
  const append=async rows=>atGovernanceStage('insert_decision','product_mapping_append',async()=>{const columns=fields.map(x=>x.split(':')[0]);const scalar=columns.filter(x=>x!=='candidate_evidence');const projections=scalar.map(name=>name==='score'?`SAFE_CAST(JSON_VALUE(row,'$.${name}') AS FLOAT64) ${name}`:name==='reviewed_at'?`TIMESTAMP(JSON_VALUE(row,'$.${name}')) ${name}`:`JSON_VALUE(row,'$.${name}') ${name}`);projections.splice(columns.indexOf('candidate_evidence'),0,"SAFE.PARSE_JSON(JSON_QUERY(row,'$.candidate_evidence')) candidate_evidence");await bigquery.query({query:`INSERT INTO \`${table}\` (${columns.join(',')}) SELECT ${projections.join(',')} FROM UNNEST(JSON_QUERY_ARRAY(@payload)) row`,params:{payload:JSON.stringify(rows)},types:{payload:'STRING'},useLegacySql:false});return rows;});
  const assertPair=(a,b)=>{if(!a?.source_product_ref||!b?.source_product_ref)throw new Error('invalid product mapping pair');if(namespace(a)===namespace(b))throw new Error('products must come from different source namespaces');};
  const activeEdges=history=>approvedMappingEdges(history);
  const validateApproval=async(candidate,edges)=>atGovernanceStage('graph_safety','product_mapping_graph_validation',async()=>{const products=await loadProducts();return assertProductGraphIntegrity({products,explicitEdges:[...edges,{...candidate,mapping_status:'resolved'}],deterministicEdges:deterministicMappingEdges(products)});});
  return {
    setup, decisions,
    async inspectCurrentGraph(history=null){
      const products=await loadProducts(),resolvedHistory=history||await decisions();
      return inspectProductGraph({products,explicitEdges:activeEdges(resolvedHistory),deterministicEdges:deterministicMappingEdges(products)});
    },
    async diagnoseExistingConflicts(productIds=[]){
      const [products,history]=await Promise.all([loadProducts(),decisions()]);
      return diagnoseExistingProductConflicts({products,explicitEdges:activeEdges(history),deterministicEdges:deterministicMappingEdges(products),requiredProductIds:productIds});
    },
    async diagnoseCandidate(candidateId,selectedRef=null){
      const [products,history]=await Promise.all([loadProducts(),decisions()]);
      let candidate=generateMappingCandidates(products,{decisions:history}).find(item=>item.candidate_id===candidateId)
        || history.find(item=>item.candidate_id===candidateId);
      if(!candidate)throw new Error(`candidate not found: ${candidateId}`);
      if(selectedRef){
        const normalizedRef=selectedRef.includes(':')&&selectedRef.startsWith('shopify:')?selectedRef:`shopify:shopify:${selectedRef}`;
        const selected=products.find(product=>product.source_product_ref===normalizedRef||product.source_product_id===selectedRef);
        if(!selected)throw new Error(`selected product not found: ${selectedRef}`);
        candidate={...candidate,right_ref:selected.source_product_ref,right_title:selected.title,candidate_method:'human_replacement',diagnostic_scenario:'choose_correct'};
      }
      return diagnoseProposedProductEdge({products,explicitEdges:activeEdges(history),deterministicEdges:deterministicMappingEdges(products),candidate});
    },
    async currentState(){return resolveMappingDecisions(await decisions());},
    async list({ products, search = '' } = {}) { await setup(); const history=await decisions(); const items=generateMappingCandidates(products || await loadProducts(),{decisions:history}).filter(x=>!search || `${x.left_title} ${x.right_title}`.toLowerCase().includes(search.toLowerCase())).slice(0,250); return { items, summary:`I found ${items.filter(x=>x.confidence==='high').length} high-confidence unresolved product mappings that could improve historical product comparison.` }; },
    async search({query='',sources=[],exclude_ref=null,limit=50,products}={}){await setup();const [items,history]=await Promise.all([products?Promise.resolve(products):loadProducts(),decisions()]);return {items:searchProducts(items,{query,sources,excludeRef:exclude_ref,limit,decisions:history}),limit:Math.min(Number(limit)||50,100)};},
    async history(filters={}){await setup();const products=await loadProducts();const productByRef=new Map(products.map(p=>[p.source_product_ref,p]));const state=resolveMappingDecisions(await decisions());const graph=inspectProductGraph({products,explicitEdges:approvedMappingEdges(state.history)});const conflictIds=new Set(graph.conflict_diagnostics.flatMap(c=>c.decision_ids));let items=state.history.map(d=>({...d,left_product:productByRef.get(d.left_ref)||null,right_product:productByRef.get(d.right_ref)||null,current:state.current.includes(d),graph_conflict:conflictIds.has(d.decision_id||d.event_id),canonical_relationship:d.status==='approved'&&!state.current.includes(d)?'historical':state.activeApproved.includes(d)?'active':'none'}));if(filters.status==='conflicts')items=items.filter(d=>d.graph_conflict);else if(!filters.status)items=items.filter(d=>d.current);else if(filters.status!=='all')items=items.filter(d=>filters.status==='superseded'?state.superseded.includes(d):d.status===filters.status);if(filters.source)items=items.filter(d=>d.left_ref.startsWith(filters.source+':')||d.right_ref.startsWith(filters.source+':'));if(filters.search)items=items.filter(d=>`${d.left_title} ${d.right_title}`.toLowerCase().includes(String(filters.search).toLowerCase()));if(filters.reviewer)items=items.filter(d=>d.reviewed_by===filters.reviewer);if(filters.start_date)items=items.filter(d=>String(d.reviewed_at)>=filters.start_date);if(filters.end_date)items=items.filter(d=>String(d.reviewed_at)<=`${filters.end_date}T23:59:59.999Z`);return {items:items.sort((a,b)=>String(b.reviewed_at).localeCompare(String(a.reviewed_at))),counts:{approved:state.activeApproved.length,rejected:state.activeRejected.length,revoked:state.revoked.length,superseded:state.superseded.length,conflicts:graph.summary.conflicted_components},conflicts:graph.conflict_diagnostics};},
    async review(candidate,status,reviewer,note=null){await setup();if(!['approved','rejected'].includes(status))throw new Error('status must be approved or rejected');const history=await decisions();if(status==='approved')await validateApproval(candidate,activeEdges(history));const [row]=await append([makeDecision(candidate,status,reviewer,{note})]);return row;},
    async chooseCorrect({candidate,selected,note},reviewer){await setup();assertPair({source_product_ref:candidate.left_ref,source_platform:candidate.left_ref.split(':')[0],source_store:candidate.left_ref.split(':')[1]},selected);const history=await decisions();const replacement={left_ref:candidate.left_ref,right_ref:selected.source_product_ref,left_title:candidate.left_title,right_title:selected.title,candidate_method:'human_replacement'};await validateApproval(replacement,activeEdges(history));const rejected=makeDecision(candidate,'rejected',reviewer,{note,provenance:'oracle_choose_correct_product'});const approved=makeDecision(replacement,'approved',reviewer,{note,provenance:'oracle_choose_correct_product',replacementFor:rejected.decision_id});await append([rejected,approved]);return {rejected,approved};},
    async createMapping({left,right,note},reviewer){await setup();assertPair(left,right);const pair={left_ref:left.source_product_ref,right_ref:right.source_product_ref,left_title:left.title,right_title:right.title,candidate_method:'human_created'};const history=await decisions();await validateApproval(pair,activeEdges(history));const [approved]=await append([makeDecision(pair,'approved',reviewer,{note,provenance:'oracle_manual_mapping'})]);return {approved};},
    async changeMapping({decision_id,replacement,note},reviewer){await setup();const history=await decisions(),state=resolveMappingDecisions(history),old=state.byId.get(decision_id);if(!old||!state.activeApproved.includes(old))throw new Error('approved mapping is not active');const anchored=old.left_ref===replacement.source_product_ref?old.right_ref:old.left_ref;const replacementPair={left_ref:anchored,right_ref:replacement.source_product_ref,left_title:old.left_ref===anchored?old.left_title:old.right_title,right_title:replacement.title,candidate_method:'human_replacement'};const withoutOld=state.activeApproved.filter(d=>d!==old);await validateApproval(replacementPair,approvedMappingEdges(withoutOld));const revoked=makeDecision(old,'superseded',reviewer,{note,provenance:'oracle_change_mapping',supersedes:decision_id});const approved=makeDecision(replacementPair,'approved',reviewer,{note,provenance:'oracle_change_mapping',replacementFor:decision_id});await append([revoked,approved]);return {superseded:revoked,approved};},
    async revokeMapping({decision_id,note},reviewer){await setup();const state=resolveMappingDecisions(await decisions()),old=state.byId.get(decision_id);if(!old||!state.activeApproved.includes(old))throw new Error('approved mapping is not active');const [revoked]=await append([makeDecision(old,'revoked',reviewer,{note,provenance:'oracle_revoke_mapping',supersedes:decision_id})]);return {revoked};},
    async reconsider({decision_id,approve=false,note},reviewer){await setup();const state=resolveMappingDecisions(await decisions()),old=state.byId.get(decision_id);if(!old||old.status!=='rejected')throw new Error('rejected decision was not found');if(approve)await validateApproval(old,activeEdges(state.history));const [decision]=await append([makeDecision(old,approve?'approved':'reconsidered',reviewer,{note,provenance:'oracle_reconsider_rejection',supersedes:decision_id})]);return {decision};}
  };
}

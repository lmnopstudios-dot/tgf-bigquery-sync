import crypto from 'node:crypto';
import { assertProductGraphExtensionIntegrity, assertProductGraphIntegrity, diagnoseProposedProductEdge, inspectProductGraph } from './product-graph-integrity.js';
import { mapProductPair } from './product-identity.js';
import { atGovernanceStage } from './governance-diagnostics.js';

export const PRODUCT_MAPPING_DATASET = 'commerce';
export const PRODUCT_MAPPING_TABLE = 'product_mapping_decisions';
export const PRODUCT_FAMILY_TABLE = 'product_family_decisions';
export const PRODUCT_REVIEW_OUTCOME_TABLE = 'product_mapping_review_outcomes';
export const CANDIDATE_STATUSES = Object.freeze(['suggested', 'approved', 'rejected', 'revoked', 'superseded', 'reconsidered']);
export const MAX_REVIEW_NOTE_LENGTH = 500;
export const PRODUCT_MAPPING_DEFAULT_PAGE_SIZE = 25;
export const PRODUCT_MAPPING_MAX_PAGE_SIZE = 50;
export const PRODUCT_MAPPING_SCHEMA=Object.freeze(['event_id:STRING','decision_id:STRING','relationship_id:STRING','candidate_id:STRING','left_ref:STRING','right_ref:STRING','left_title:STRING','right_title:STRING','suggested_canonical_title:STRING','candidate_method:STRING','candidate_evidence:JSON','score:FLOAT64','confidence:STRING','status:STRING','mapping_method:STRING','reviewed_by:STRING','reviewed_at:TIMESTAMP','provenance:STRING','note:STRING','supersedes_decision_id:STRING','replacement_for_decision_id:STRING']);
export const PRODUCT_FAMILY_SCHEMA=Object.freeze(['event_id:STRING','decision_id:STRING','membership_id:STRING','source_ref:STRING','source_title:STRING','shopify_parent_ref:STRING','shopify_parent_title:STRING','status:STRING','reviewed_by:STRING','reviewed_at:TIMESTAMP','provenance:STRING','note:STRING','supersedes_decision_id:STRING','replacement_for_decision_id:STRING']);
export const PRODUCT_REVIEW_OUTCOME_SCHEMA=Object.freeze(['event_id:STRING','source_ref:STRING','source_title:STRING','outcome:STRING','reviewed_by:STRING','reviewed_at:TIMESTAMP','provenance:STRING','note:STRING','request_id:STRING']);

const words = value => String(value || '').normalize('NFKC').toLocaleLowerCase('en')
  .replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
const pairKey = (a, b) => [a, b].sort().join('\u0000');
export const relationshipId = (a, b) => crypto.createHash('sha256').update(pairKey(a, b)).digest('hex').slice(0, 24);
const namespace = product => `${product.source_platform}:${product.source_store}`;
export const productSourceLabel = value => ({'woo:ww':'WooCommerce WW','woo:usd':'WooCommerce US','square:square':'Square','shopify:shopify':'Shopify'}[typeof value==='string'?value:namespace(value)] || (typeof value==='string'?value:namespace(value)));
export const productMoneyContract = value => ({
  'woo:ww':{currency_field:'currency',amount_field:'total',monetary_unit:'major_unit'},
  'woo:usd':{currency_field:'currency',amount_field:'total',monetary_unit:'major_unit'},
  'shopify:shopify':{currency_field:'presentment_currency',amount_field:'discounted_total_presentment',monetary_unit:'major_unit'},
  'square:square':{currency_field:'currency',amount_field:'total_amount',monetary_unit:'minor_unit'}
}[typeof value==='string'?value:namespace(value)]||null);
export const isShopifyParentProduct = product => product?.source_product_ref?.startsWith('shopify:shopify:') && !/ProductVariant\//i.test(`${product.source_product_id||''} ${product.source_product_ref}`);
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
export function generateMappingCandidates(products, { decisions = [], familyDecisions = [], minimumScore = .48, diagnostics = null } = {}) {
  const state=resolveMappingDecisions(decisions);
  const decided = new Map(state.current.map(d => [pairKey(d.left_ref, d.right_ref), d.status]));
  const governedRefs=new Set(state.activeApproved.flatMap(d=>[d.left_ref,d.right_ref]));
  const familyRefs=new Set(resolveFamilyDecisions(familyDecisions).active.map(x=>x.source_ref));
  const eligible = products.filter(p => p.mapping_status !== 'resolved' && !governedRefs.has(p.source_product_ref) && !familyRefs.has(p.source_product_ref) && classifyProduct(p.title, p) === 'merchandise_product');
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

/** Family membership is deliberately not a canonical identity edge. */
export function resolveFamilyDecisions(history = []) {
  const ordered=[...history].sort((a,b)=>String(a.reviewed_at||'').localeCompare(String(b.reviewed_at||''))||String(a.decision_id||a.event_id||'').localeCompare(String(b.decision_id||b.event_id||'')));
  const byId=new Map(ordered.map(d=>[d.decision_id||d.event_id,d])),superseded=new Set(ordered.map(d=>d.supersedes_decision_id).filter(Boolean)),currentBySource=new Map();
  for(const row of ordered){const id=row.decision_id||row.event_id;if(!superseded.has(id))currentBySource.set(row.source_ref,row);}
  const current=[...currentBySource.values()];
  return {history:ordered,byId,current,active:current.filter(x=>x.status==='active'),revoked:ordered.filter(x=>x.status==='revoked'),superseded:ordered.filter(x=>superseded.has(x.decision_id||x.event_id)||x.status==='superseded')};
}

export function productFamilyCtes(project,prefix='family') {
  return `${prefix}_history AS (SELECT *,COALESCE(decision_id,event_id) resolved_decision_id FROM \`${project}.${PRODUCT_MAPPING_DATASET}.${PRODUCT_FAMILY_TABLE}\`), ${prefix}_superseded AS (SELECT supersedes_decision_id decision_id FROM ${prefix}_history WHERE supersedes_decision_id IS NOT NULL), ${prefix}_ranked AS (SELECT h.*,ROW_NUMBER() OVER(PARTITION BY source_ref ORDER BY reviewed_at DESC,resolved_decision_id DESC) source_rank FROM ${prefix}_history h LEFT JOIN ${prefix}_superseded s ON s.decision_id=h.resolved_decision_id WHERE s.decision_id IS NULL), ${prefix}_current AS (SELECT * FROM ${prefix}_ranked WHERE source_rank=1), ${prefix}_active AS (SELECT * FROM ${prefix}_current WHERE status='active')`;
}
export function assertFamilyAssignment(sourceRef,parentRef,history=[],{replacingDecisionId=null}={}) {
  if(!sourceRef||!parentRef)throw new Error('source and Shopify parent are required');
  if(sourceRef.startsWith('shopify:')||!parentRef.startsWith('shopify:shopify:')||/ProductVariant\//i.test(parentRef))throw new Error('family membership requires a non-Shopify source product and Shopify parent, not a variant');
  const existing=resolveFamilyDecisions(history).active.find(x=>x.source_ref===sourceRef&&x.decision_id!==replacingDecisionId);
  if(existing&&existing.shopify_parent_ref===parentRef)throw new Error('relationship is already an active family membership');
  if(existing)throw new Error(`conflicting family assignment: ${sourceRef} is already assigned to ${existing.shopify_parent_ref}; use Change family`);
  return true;
}

const productSummary=(ref,productByRef)=>{const product=productByRef.get(ref);return{source:namespace(product||{source_platform:ref.split(':')[0],source_store:ref.split(':')[1]}),title:product?.title||null,source_product_ref:ref};};

/** Read-only, shared-authority preview for the two deliberately separate reviewer actions. */
export function buildProductChoicePreview({products=[],mappingDecisions=[],familyDecisions=[],candidate,selectedRef}={}) {
  const productByRef=new Map(products.map(product=>[product.source_product_ref,product]));
  const selected=productByRef.get(selectedRef);
  if(!selected||!isShopifyParentProduct(selected))throw new Error('selected Shopify parent product was not found');
  const originalRefs=[candidate?.left_ref,candidate?.right_ref].filter(Boolean);
  const sourceRef=originalRefs.find(ref=>!ref.startsWith('shopify:'));
  if(!sourceRef||!productByRef.has(sourceRef))throw new Error('candidate source product was not found');
  const explicitEdges=approvedMappingEdges(mappingDecisions),deterministicEdges=deterministicMappingEdges(products);
  const graph=inspectProductGraph({products,explicitEdges,deterministicEdges});
  const component=graph.components.find(item=>item.source_products.includes(selectedRef));
  const replacement={candidate_id:candidate.candidate_id,left_ref:sourceRef,right_ref:selectedRef,left_title:productByRef.get(sourceRef)?.title||null,right_title:selected.title,candidate_method:'human_replacement'};
  const diagnosis=diagnoseProposedProductEdge({products,explicitEdges,deterministicEdges,candidate:replacement});
  const familyState=resolveFamilyDecisions(familyDecisions),familyMembers=familyState.active.filter(item=>item.shopify_parent_ref===selectedRef);
  let familyReason=null;try{assertFamilyAssignment(sourceRef,selectedRef,familyDecisions)}catch(error){familyReason=error.message;}
  const previewToken=crypto.createHash('sha256').update(JSON.stringify({sourceRef,selectedRef,mapping:resolveMappingDecisions(mappingDecisions).current.map(x=>x.decision_id||x.event_id).sort(),family:familyState.current.map(x=>x.decision_id||x.event_id).sort()})).digest('hex').slice(0,24);
  return {
    read_only:true,candidate_id:candidate.candidate_id,preview_token:previewToken,selected_product:productSummary(selectedRef,productByRef),
    identity_component:(component?.source_products||[selectedRef]).map(ref=>productSummary(ref,productByRef)),
    reporting_family_members:familyMembers.map(item=>productSummary(item.source_ref,productByRef)),
    identity_preview:{allowed:diagnosis.new_conflicts.length===0,conflicting_products:diagnosis.new_conflicts.flatMap(conflict=>conflict.products.map(item=>productSummary(item.source_product_ref,productByRef))),reason:diagnosis.new_conflicts.length?diagnosis.diagnosis:null},
    family_preview:{allowed:!familyReason,reason:familyReason,source_ref:sourceRef,shopify_parent_ref:selectedRef,source_identity_preserved:true,canonical_graph_changed:false}
  };
}

/** Ranks Shopify parent suggestions for a historical row. Evidence is explanatory only. */
export function suggestShopifyParents(source, products, {limit=3}={}) {
  if(!source?.source_product_ref||source.source_product_ref.startsWith('shopify:'))return [];
  const sourceSku=String(source.sku||'').trim().toUpperCase();
  const sourceWords=words(source.title),sizeTokens=sourceWords.filter(x=>/^\d+(?:\.\d+)?(?:mm|cm)?$/.test(x)||/^(?:xx?s|[smlx]{1,3})$/.test(x));
  return products.filter(isShopifyParentProduct).map(parent=>{
    const title=similarity(source.title,parent.title),parentSku=String(parent.sku||'').trim().toUpperCase(),exactSku=Boolean(sourceSku&&parentSku&&sourceSku===parentSku);
    const parentWords=words(parent.title),conflicts=[];
    if(sourceSku&&parentSku&&!exactSku)conflicts.push(`SKU differs (${sourceSku} vs ${parentSku})`);
    const unmatchedSize=sizeTokens.filter(x=>!parentWords.includes(x));if(unmatchedSize.length)conflicts.push(`variant/size only on historical product: ${unmatchedSize.join(', ')}`);
    const score=Math.min(1,title.score+(exactSku?.4:0)+(title.equivalent?.2:0));
    const supporting=[...(exactSku?['exact SKU']:[]),...(title.equivalent?['normalized title matches']:[]),...(title.shared.length?[`shared title tokens: ${title.shared.join(', ')}`]:[])];
    return {source_product_ref:parent.source_product_ref,source_product_id:parent.source_product_id,title:parent.title,sku:parent.sku||null,score,supporting_evidence:supporting,conflicting_evidence:conflicts,ambiguous:false};
  }).filter(x=>x.score>=.25).sort((a,b)=>b.score-a.score||String(a.title).localeCompare(String(b.title))).slice(0,limit).map((x,_,all)=>({...x,ambiguous:all.length>1&&Math.abs(x.score-all[0].score)<.08}));
}
export function applyProductFamilies(rows,history=[]) {
  const active=resolveFamilyDecisions(history).active,bySource=new Map(active.map(x=>[x.source_ref,x])),parents=new Map(active.map(x=>[x.shopify_parent_ref,x]));
  return rows.map(row=>{const ref=row.source_product_ref||`${row.source_platform}:${row.source_store}:${row.source_product_id}`,family=bySource.get(ref)||parents.get(ref);return family?{...row,reporting_product_ref:`family:${family.shopify_parent_ref}`,reporting_title:family.shopify_parent_title,mapping_method:'governed_product_family'}:{...row,reporting_product_ref:row.product_ref||`source:${ref}`};});
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

/** Presents suggestions as evidence for one historical product, never as a final mapping. */
export function buildHistoricalReviewQueue(products, candidates, { mappingDecisions=[], familyDecisions=[], reviewOutcomes=[] } = {}) {
  const byRef=new Map(products.map(item=>[item.source_product_ref,item])),identity=resolveMappingDecisions(mappingDecisions).activeApproved,families=resolveFamilyDecisions(familyDecisions).active;
  const identityByRef=new Map(),familyByRef=new Map(families.map(item=>[item.source_ref,item])),evidenceByRef=new Map();
  for(const decision of identity)for(const ref of [decision.left_ref,decision.right_ref])identityByRef.set(ref,decision);
  for(const candidate of candidates)for(const ref of [candidate.left_ref,candidate.right_ref]){if(typeof ref!=='string'||!ref||ref.startsWith('shopify:'))continue;const evidence=evidenceByRef.get(ref)||[];evidence.push(candidate);evidenceByRef.set(ref,evidence);}
  const latestOutcome=new Map([...reviewOutcomes].sort((a,b)=>String(a.reviewed_at).localeCompare(String(b.reviewed_at))).map(x=>[x.source_ref,x]));
  const historical=products.filter(x=>typeof x.source_product_ref==='string'&&!x.source_product_ref.startsWith('shopify:')&&x.mapping_status!=='resolved'&&classifyProduct(x.title,x)==='merchandise_product');
  return historical.map(source=>{const ref=source.source_product_ref,evidence=evidenceByRef.get(ref)||[],identityDecision=identityByRef.get(ref),familyDecision=familyByRef.get(ref),outcome=latestOutcome.get(ref);const suggestions=suggestShopifyParents(source,products);const proposed=suggestions[0]||null;return{historical_product:{...source,source_label:productSourceLabel(source),money_contract:productMoneyContract(source)},resolution_status:identityDecision?'active_identity':familyDecision?'active_reporting_family':outcome?.outcome||'needs_review',active_identity_mapping:identityDecision||null,active_family_assignment:familyDecision||null,review_outcome:outcome||null,evidence:evidence.sort((a,b)=>b.score-a.score),shopify_suggestions:suggestions,proposed_shopify_parent:proposed,candidate:{candidate_id:relationshipId(ref,proposed?.source_product_ref||'unresolved'),left_ref:ref,right_ref:proposed?.source_product_ref||'',left_title:source.title,right_title:proposed?.title||null,candidate_method:'shopify_parent_suggestion',candidate_evidence:{summary:proposed?.supporting_evidence||[],conflicts:proposed?.conflicting_evidence||[]},score:proposed?.score||0}};}).sort((a,b)=>namespace(a.historical_product).localeCompare(namespace(b.historical_product))||String(a.historical_product.currency||'').localeCompare(String(b.historical_product.currency||''))||Number(b.historical_product.sales||0)-Number(a.historical_product.sales||0)||Number(b.historical_product.line_items||0)-Number(a.historical_product.line_items||0)||String(a.historical_product.title).localeCompare(String(b.historical_product.title)));
}

/** Cheap queue state used before suggestion ranking. Keep this O(products + history). */
export function buildHistoricalReviewIndex(products, {mappingDecisions=[],familyDecisions=[],reviewOutcomes=[]}={}) {
  const identity=new Map(),families=new Map(resolveFamilyDecisions(familyDecisions).active.map(x=>[x.source_ref,x]));
  for(const decision of resolveMappingDecisions(mappingDecisions).activeApproved)for(const ref of [decision.left_ref,decision.right_ref])identity.set(ref,decision);
  const outcomes=new Map([...reviewOutcomes].sort((a,b)=>String(a.reviewed_at||'').localeCompare(String(b.reviewed_at||''))).map(x=>[x.source_ref,x]));
  return products.filter(x=>typeof x.source_product_ref==='string'&&!x.source_product_ref.startsWith('shopify:')&&x.mapping_status!=='resolved'&&classifyProduct(x.title,x)==='merchandise_product').map(source=>{
    const ref=source.source_product_ref,outcome=outcomes.get(ref),identityDecision=identity.get(ref),familyDecision=families.get(ref);
    return {historical_product:{...source,source_label:productSourceLabel(source),money_contract:productMoneyContract(source)},resolution_status:identityDecision?'active_identity':familyDecision?'active_reporting_family':outcome?.outcome||'needs_review',active_identity_mapping:identityDecision||null,active_family_assignment:familyDecision||null,review_outcome:outcome||null};
  });
}

export function buildProductMappingCoverage(products, queue, {mappingDecisions=[],familyDecisions=[],reviewOutcomes=[]}={}) {
  const mappingRefs=new Set(resolveMappingDecisions(mappingDecisions).activeApproved.flatMap(x=>[x.left_ref,x.right_ref]));
  const familyRefs=new Set(resolveFamilyDecisions(familyDecisions).active.map(x=>x.source_ref));
  const outcomeByRef=new Map([...reviewOutcomes].sort((a,b)=>String(a.reviewed_at||'').localeCompare(String(b.reviewed_at||''))).map(x=>[x.source_ref,x.outcome]));
  const historical=products.filter(x=>typeof x.source_product_ref==='string'&&!x.source_product_ref.startsWith('shopify:'));
  const stateOf=x=>mappingRefs.has(x.source_product_ref)?'active_identity':familyRefs.has(x.source_product_ref)?'active_reporting_family':outcomeByRef.get(x.source_product_ref)==='no_equivalent'?'no_equivalent':x.mapping_status==='resolved'?'deterministic_match':classifyProduct(x.title,x)!=='merchandise_product'?`excluded_${classifyProduct(x.title,x)}`:outcomeByRef.get(x.source_product_ref)==='needs_investigation'?'needs_investigation':'needs_review';
  const money=rows=>{const totals=new Map();for(const row of rows)for(const value of row.sales_by_currency||[{currency:row.currency||'UNKNOWN',monetary_unit:row.monetary_unit||productMoneyContract(row)?.monetary_unit||'unknown',sales:row.sales||0}]){const key=`${value.currency||'UNKNOWN'}:${value.monetary_unit||'unknown'}`;totals.set(key,(totals.get(key)||0)+Number(value.sales||0));}return[...totals].map(([key,sales])=>{const split=key.lastIndexOf(':');return{currency:key.slice(0,split),monetary_unit:key.slice(split+1),sales};}).sort((a,b)=>a.currency.localeCompare(b.currency)||a.monetary_unit.localeCompare(b.monetary_unit));};
  const summarize=rows=>({products:rows.length,order_lines:rows.reduce((n,x)=>n+Number(x.line_items||0),0),sales_by_currency:money(rows)});
  const by_source={};for(const source of ['woo:ww','woo:usd','square:square']){const rows=historical.filter(x=>namespace(x)===source),states=rows.reduce((all,row)=>{(all[stateOf(row)]??=[]).push(row);return all;},{}),reviewable=rows.filter(x=>['needs_review','needs_investigation'].includes(stateOf(x)));by_source[source]={source_label:productSourceLabel(source),money_contract:productMoneyContract(source),...summarize(rows),reviewable:summarize(reviewable),completed:rows.filter(x=>['active_identity','active_reporting_family','no_equivalent'].includes(stateOf(x))).length,identity_resolved:(states.active_identity||[]).length,family_resolved:(states.active_reporting_family||[]).length,no_equivalent:(states.no_equivalent||[]).length,needs_investigation:(states.needs_investigation||[]).length,needs_review:(states.needs_review||[]).length,deterministic_match:(states.deterministic_match||[]).length,intentional_exclusions:Object.fromEntries(Object.entries(states).filter(([key])=>key.startsWith('excluded_')).map(([key,value])=>[key.slice(9),summarize(value)])),classification_impact:Object.fromEntries([...new Set(reviewable.map(x=>classifyProduct(x.title,x)))].map(c=>[c,summarize(reviewable.filter(x=>classifyProduct(x.title,x)===c))]))};}
  const categories={active_identity:0,active_reporting_family:0,no_equivalent:0,needs_investigation:0,needs_review:0,deterministic_match:0,intentional_exclusions:0};for(const row of historical){const state=stateOf(row);if(state.startsWith('excluded_'))categories.intentional_exclusions++;else categories[state]++;}
  const completed=categories.active_identity+categories.active_reporting_family+categories.no_equivalent,remaining=categories.needs_review+categories.needs_investigation;
  return {by_source,completed,remaining,total:historical.length,categories,reconciliation:{equation:'total = completed + remaining + deterministic_match + intentional_exclusions',reconciled:historical.length===completed+remaining+categories.deterministic_match+categories.intentional_exclusions,overlap_products:0,missing_products:0}};
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
  const familyTable = `${project}.${dataset}.${PRODUCT_FAMILY_TABLE}`;
  const outcomeTable = `${project}.${dataset}.${PRODUCT_REVIEW_OUTCOME_TABLE}`;
  const fields=PRODUCT_MAPPING_SCHEMA;
  const schemaFields=()=>fields.map(spec=>{const [name,type]=spec.split(':');return {name,type};});
  const setup = async () => atGovernanceStage('ensure_schema','product_mapping_ensure_table',async() => {
    const ds=bigquery.dataset(dataset); const [exists]=await ds.exists(); if(!exists) await ds.create({location:'EU',labels:{component:'product_identity'}});
    const target=ds.table(PRODUCT_MAPPING_TABLE); const [found]=await target.exists();
    if(!found) await target.create({schema:{fields:schemaFields()},timePartitioning:{type:'DAY',field:'reviewed_at'},labels:{component:'product_identity'}});
    else if(target.getMetadata&&target.setMetadata){const [meta]=await target.getMetadata();const current=meta.schema?.fields||[];const names=new Set(current.map(f=>f.name));const additions=schemaFields().filter(f=>!names.has(f.name));if(additions.length)await target.setMetadata({schema:{fields:[...current,...additions]}});}
    const family=ds.table(PRODUCT_FAMILY_TABLE);const [familyFound]=await family.exists();const familyFields=PRODUCT_FAMILY_SCHEMA.map(spec=>{const [name,type]=spec.split(':');return {name,type};});
    if(!familyFound)await family.create({schema:{fields:familyFields},timePartitioning:{type:'DAY',field:'reviewed_at'},labels:{component:'product_reporting_family'}});
    else if(family.getMetadata&&family.setMetadata){const [meta]=await family.getMetadata();const names=new Set((meta.schema?.fields||[]).map(f=>f.name));const additions=familyFields.filter(f=>!names.has(f.name));if(additions.length)await family.setMetadata({schema:{fields:[...(meta.schema?.fields||[]),...additions]}});}
    const outcomes=ds.table(PRODUCT_REVIEW_OUTCOME_TABLE);const [outcomesFound]=await outcomes.exists();if(!outcomesFound)await outcomes.create({schema:{fields:PRODUCT_REVIEW_OUTCOME_SCHEMA.map(spec=>{const [name,type]=spec.split(':');return{name,type};})},timePartitioning:{type:'DAY',field:'reviewed_at'},labels:{component:'product_mapping_review'}});
  });
  const decisions = async () => atGovernanceStage('load_current_decision','product_mapping_history',async()=>{ const [rows] = await bigquery.query({ query:`SELECT * FROM \`${table}\` ORDER BY reviewed_at,COALESCE(decision_id,event_id)`, useLegacySql:false }); return rows.map(d=>({...d,decision_id:d.decision_id||d.event_id,relationship_id:d.relationship_id||relationshipId(d.left_ref,d.right_ref)})); });
  const familyDecisions=async()=>atGovernanceStage('load_current_decision','product_family_history',async()=>{const [rows]=await bigquery.query({query:`SELECT * FROM \`${familyTable}\` ORDER BY reviewed_at,COALESCE(decision_id,event_id)`,useLegacySql:false});return rows;});
  const reviewOutcomes=async()=>atGovernanceStage('load_current_decision','product_mapping_review_outcomes',async()=>{const [rows]=await bigquery.query({query:`SELECT * FROM \`${outcomeTable}\` ORDER BY reviewed_at,event_id`,useLegacySql:false});return rows;});
  const loadProducts = async () => atGovernanceStage('load_products','product_mapping_products',async()=>{ const [rows]=await bigquery.query({query:`WITH lines AS (
SELECT 'woo' source_platform,'ww' source_store,CAST(product_id AS STRING) source_product_id,name title,sku,quantity units,total sales,UPPER(currency) currency,'major_unit' monetary_unit FROM \`${project}.metorik_uk.order_line_items\`
UNION ALL SELECT 'woo','usd',CAST(product_id AS STRING),name,sku,quantity,total,UPPER(currency),'major_unit' FROM \`${project}.metorik_us.order_line_items\`
UNION ALL SELECT 'shopify','shopify',li.product_id,COALESCE(li.title,li.name),li.sku,li.quantity,li.discounted_total_presentment,UPPER(li.presentment_currency),'major_unit' FROM \`${project}.shopify_data.order_line_items\` li JOIN \`${project}.shopify_data.order_locations\` l USING(order_id) WHERE l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145'
UNION ALL SELECT 'square','square',COALESCE(JSON_VALUE(SAFE.PARSE_JSON(transaction_line_item_json),'$.item_id'),catalog_object_id),transaction_item_name,transaction_sku,quantity,total_amount,UPPER(currency),'minor_unit' FROM \`${project}.square_data.retail_order_items\`),
ranked AS (SELECT *,COUNT(*) OVER(PARTITION BY source_platform,source_store,source_product_id,title) title_lines FROM lines WHERE source_product_id IS NOT NULL AND source_product_id!=''),
money AS (SELECT source_platform,source_store,source_product_id,currency,monetary_unit,SUM(sales) sales FROM ranked GROUP BY 1,2,3,4,5),
product_base AS (SELECT source_platform,source_store,source_product_id,CONCAT(source_platform,':',source_store,':',source_product_id) source_product_ref,ARRAY_AGG(STRUCT(title,title_lines) ORDER BY title_lines DESC,title LIMIT 1)[OFFSET(0)].title title,ARRAY_AGG(NULLIF(sku,'') IGNORE NULLS LIMIT 1)[SAFE_OFFSET(0)] sku,COUNT(*) line_items FROM ranked GROUP BY 1,2,3),
products AS (SELECT p.*,IF(COUNT(*)=1,ANY_VALUE(m.sales),NULL) sales,IF(COUNT(*)=1,ANY_VALUE(m.currency),NULL) currency,IF(COUNT(*)=1,ANY_VALUE(m.monetary_unit),NULL) monetary_unit,ARRAY_AGG(STRUCT(m.currency,m.monetary_unit,m.sales) ORDER BY m.currency,m.monetary_unit) sales_by_currency FROM product_base p JOIN money m USING(source_platform,source_store,source_product_id) GROUP BY ALL),
normalized AS (SELECT *,LOWER(TRIM(REGEXP_REPLACE(NORMALIZE(title,NFKC),r'\s+',' '))) normalized_title,NULLIF(UPPER(TRIM(sku)),'') exact_sku FROM products),
keyed AS (SELECT *,COUNT(*) OVER(PARTITION BY source_platform,source_store,normalized_title) local_title_count,COUNT(DISTINCT CONCAT(source_platform,':',source_store)) OVER(PARTITION BY normalized_title) title_sources,COUNT(*) OVER(PARTITION BY source_platform,source_store,exact_sku) local_sku_count,COUNT(DISTINCT CONCAT(source_platform,':',source_store)) OVER(PARTITION BY exact_sku) sku_sources FROM normalized)
SELECT * EXCEPT(exact_sku,local_title_count,title_sources,local_sku_count,sku_sources),IF((exact_sku IS NOT NULL AND local_sku_count=1 AND sku_sources>1) OR (normalized_title!='' AND local_title_count=1 AND title_sources>1),'resolved','source_specific') mapping_status FROM keyed`,useLegacySql:false,maximumBytesBilled:'10000000000',labels:{component:'product_mapping',operation:'load_products'}}); return rows; });
  const buildList=async({products,search='',source='',sort='impact',page=1,pageSize=PRODUCT_MAPPING_DEFAULT_PAGE_SIZE,ensureSchema=true,diagnostic=false,signal}={})=>{
    const timings={},timed=async(name,action)=>{if(signal?.aborted)throw Object.assign(new Error('mapping request cancelled'),{code:'ABORT_ERR'});const started=performance.now(),cpu=process.cpuUsage();try{return await action()}finally{const used=process.cpuUsage(cpu);timings[name]={wall_ms:Math.round((performance.now()-started)*10)/10,cpu_ms:Math.round((used.user+used.system)/100)/10}}};
    if(ensureSchema)await timed('ensure_schema',setup);
    const [history,families,outcomes]=await Promise.all([timed('mapping_decisions',decisions),timed('family_decisions',familyDecisions),timed('review_outcomes',reviewOutcomes)]);
    const catalog=products||await timed('products',loadProducts);
    const allItems=await timed('historical_grouping',()=>atGovernanceStage('historical_grouping',null,async()=>buildHistoricalReviewIndex(catalog,{mappingDecisions:history,familyDecisions:families,reviewOutcomes:outcomes})));
    let items=allItems.filter(x=>['needs_review','needs_investigation'].includes(x.resolution_status));
    if(search)items=items.filter(x=>`${x.historical_product.title} ${x.historical_product.source_product_id} ${x.historical_product.sku||''} ${x.historical_product.source_label}`.toLowerCase().includes(search.toLowerCase()));
    if(source)items=items.filter(x=>namespace(x.historical_product)===source);
    const comparators={impact:(a,b)=>namespace(a.historical_product).localeCompare(namespace(b.historical_product))||String(a.historical_product.currency||'').localeCompare(String(b.historical_product.currency||''))||Number(b.historical_product.sales||0)-Number(a.historical_product.sales||0)||Number(b.historical_product.line_items||0)-Number(a.historical_product.line_items||0),lines:(a,b)=>Number(b.historical_product.line_items||0)-Number(a.historical_product.line_items||0),title:(a,b)=>String(a.historical_product.title).localeCompare(String(b.historical_product.title)),source:(a,b)=>namespace(a.historical_product).localeCompare(namespace(b.historical_product))};
    items.sort((comparators[sort]||comparators.impact));
    const matchingItems=items.length,size=Math.max(1,Math.min(Number(pageSize)||PRODUCT_MAPPING_DEFAULT_PAGE_SIZE,PRODUCT_MAPPING_MAX_PAGE_SIZE)),currentPage=Math.max(1,Number(page)||1),offset=(currentPage-1)*size;
    items=items.slice(offset,offset+size);
    items=await timed('suggestion_ranking',async()=>{const ranked=[];await new Promise(resolve=>setImmediate(resolve));for(const item of items){if(signal?.aborted)throw Object.assign(new Error('mapping request cancelled'),{code:'ABORT_ERR'});const sourceProduct=item.historical_product,suggestions=suggestShopifyParents(sourceProduct,catalog),proposed=suggestions[0]||null;ranked.push({...item,evidence:[],shopify_suggestions:suggestions,proposed_shopify_parent:proposed,candidate:{candidate_id:relationshipId(sourceProduct.source_product_ref,proposed?.source_product_ref||'unresolved'),left_ref:sourceProduct.source_product_ref,right_ref:proposed?.source_product_ref||'',left_title:sourceProduct.title,right_title:proposed?.title||null,candidate_method:'shopify_parent_suggestion',candidate_evidence:{summary:proposed?.supporting_evidence||[],conflicts:proposed?.conflicting_evidence||[]},score:proposed?.score||0},authoritative_preview:null});await new Promise(resolve=>setImmediate(resolve));}return ranked;});
    const historical=catalog.filter(x=>typeof x.source_product_ref==='string'&&!x.source_product_ref.startsWith('shopify:'));
    const identityRefs=new Set(resolveMappingDecisions(history).activeApproved.flatMap(x=>[x.left_ref,x.right_ref]).filter(x=>typeof x==='string'&&!x.startsWith('shopify:'))),familyRefs=new Set(resolveFamilyDecisions(families).active.map(x=>x.source_ref));
    const counts={needs_review:allItems.filter(x=>x.resolution_status==='needs_review'||x.resolution_status==='needs_investigation').length,active_identity:historical.filter(x=>identityRefs.has(x.source_product_ref)).length,active_reporting_family:historical.filter(x=>familyRefs.has(x.source_product_ref)).length,ui_queue_eligible:allItems.filter(x=>['needs_review','needs_investigation'].includes(x.resolution_status)).length,ui_matching:matchingItems,ui_returned:items.length,ui_limit:PRODUCT_MAPPING_MAX_PAGE_SIZE};
    const coverage=buildProductMappingCoverage(catalog,allItems,{mappingDecisions:history,familyDecisions:families,reviewOutcomes:outcomes});
    if(diagnostic){const candidates=await timed('candidate_generation',()=>generateMappingCandidates(catalog,{decisions:history,familyDecisions:families}));return{read_only:true,search_empty:search==='',stage:'complete',counts:{...counts,products:catalog.length,candidates:candidates.length,mapping_decisions:history.length,family_decisions:families.length,review_outcomes:outcomes.length},coverage,timing_ms:timings};}
    return {items,counts,coverage,pagination:{page:currentPage,page_size:size,total_items:matchingItems,total_pages:Math.max(1,Math.ceil(matchingItems/size))},timing_ms:timings,summary:`${coverage.completed} completed · ${coverage.remaining} remaining · ${identityRefs.size} identity mappings · ${familyRefs.size} reporting-family assignments.`};
  };
  const stableId=(requestId,suffix)=>requestId?crypto.createHash('sha256').update(`${requestId}:${suffix}`).digest('hex').slice(0,32):crypto.randomUUID();
  const makeDecision=(pair,status,reviewer,{note=null,provenance='oracle_product_mapping_review',supersedes=null,replacementFor=null,requestId=null}={})=>{const decision_id=stableId(requestId,`${status}:${pair.left_ref}:${pair.right_ref}`);return {event_id:decision_id,decision_id,relationship_id:relationshipId(pair.left_ref,pair.right_ref),candidate_id:pair.candidate_id||relationshipId(pair.left_ref,pair.right_ref),left_ref:pair.left_ref,right_ref:pair.right_ref,left_title:pair.left_title||null,right_title:pair.right_title||null,suggested_canonical_title:pair.suggested_canonical_title||null,candidate_method:pair.candidate_method||'human_selected',candidate_evidence:pair.candidate_evidence||{},score:Number(pair.score||0),confidence:pair.confidence||null,status,mapping_method:status==='approved'?'explicit_governed_mapping':null,reviewed_by:reviewer,reviewed_at:new Date().toISOString(),provenance,note:sanitizeReviewerNote(note),supersedes_decision_id:supersedes,replacement_for_decision_id:replacementFor};};
  // One DML statement is atomic in BigQuery: a correction can never retain only
  // its rejection or only its replacement approval.
  const append=async rows=>atGovernanceStage('insert_decision','product_mapping_append',async()=>{const columns=fields.map(x=>x.split(':')[0]);const scalar=columns.filter(x=>x!=='candidate_evidence');const projections=scalar.map(name=>name==='score'?`SAFE_CAST(JSON_VALUE(row,'$.${name}') AS FLOAT64) ${name}`:name==='reviewed_at'?`TIMESTAMP(JSON_VALUE(row,'$.${name}')) ${name}`:`JSON_VALUE(row,'$.${name}') ${name}`);projections.splice(columns.indexOf('candidate_evidence'),0,"SAFE.PARSE_JSON(JSON_QUERY(row,'$.candidate_evidence')) candidate_evidence");await bigquery.query({query:`MERGE \`${table}\` target USING (SELECT ${projections.join(',')} FROM UNNEST(JSON_QUERY_ARRAY(@payload)) row) incoming ON target.decision_id=incoming.decision_id WHEN NOT MATCHED THEN INSERT (${columns.join(',')}) VALUES (${columns.map(x=>`incoming.${x}`).join(',')})`,params:{payload:JSON.stringify(rows)},types:{payload:'STRING'},useLegacySql:false});return rows;});
  const appendFamily=async rows=>atGovernanceStage('insert_decision','product_family_append',async()=>{const columns=PRODUCT_FAMILY_SCHEMA.map(x=>x.split(':')[0]);const projections=columns.map(name=>name==='reviewed_at'?`TIMESTAMP(JSON_VALUE(row,'$.${name}')) ${name}`:`JSON_VALUE(row,'$.${name}') ${name}`);await bigquery.query({query:`MERGE \`${familyTable}\` target USING (SELECT ${projections.join(',')} FROM UNNEST(JSON_QUERY_ARRAY(@payload)) row) incoming ON target.decision_id=incoming.decision_id WHEN NOT MATCHED THEN INSERT (${columns.join(',')}) VALUES (${columns.map(x=>`incoming.${x}`).join(',')})`,params:{payload:JSON.stringify(rows)},types:{payload:'STRING'},useLegacySql:false});return rows;});
  const appendOutcome=async row=>atGovernanceStage('insert_decision','product_review_outcome_append',async()=>{await bigquery.query({query:`MERGE \`${outcomeTable}\` target USING (SELECT JSON_VALUE(@payload,'$.event_id') event_id,JSON_VALUE(@payload,'$.source_ref') source_ref,JSON_VALUE(@payload,'$.source_title') source_title,JSON_VALUE(@payload,'$.outcome') outcome,JSON_VALUE(@payload,'$.reviewed_by') reviewed_by,TIMESTAMP(JSON_VALUE(@payload,'$.reviewed_at')) reviewed_at,JSON_VALUE(@payload,'$.provenance') provenance,JSON_VALUE(@payload,'$.note') note,JSON_VALUE(@payload,'$.request_id') request_id) incoming ON target.event_id=incoming.event_id WHEN NOT MATCHED THEN INSERT ROW`,params:{payload:JSON.stringify(row)},types:{payload:'STRING'},useLegacySql:false});return row;});
  const makeFamilyDecision=(source,parent,status,reviewer,{note=null,provenance='oracle_product_family_review',supersedes=null,replacementFor=null,requestId=null}={})=>{const decision_id=stableId(requestId,`${status}:${source.source_product_ref}:${parent.source_product_ref}`);return{event_id:decision_id,decision_id,membership_id:relationshipId(source.source_product_ref,parent.source_product_ref),source_ref:source.source_product_ref,source_title:source.title||null,shopify_parent_ref:parent.source_product_ref,shopify_parent_title:parent.title||null,status,reviewed_by:reviewer,reviewed_at:new Date().toISOString(),provenance,note:sanitizeReviewerNote(note),supersedes_decision_id:supersedes,replacement_for_decision_id:replacementFor};};
  const assertPair=(a,b)=>{if(!a?.source_product_ref||!b?.source_product_ref)throw new Error('invalid product mapping pair');if(namespace(a)===namespace(b))throw new Error('products must come from different source namespaces');};
  const activeEdges=history=>approvedMappingEdges(history);
  const validateApproval=async(candidate,edges)=>atGovernanceStage('graph_safety','product_mapping_graph_validation',async()=>{const products=await loadProducts();return assertProductGraphExtensionIntegrity({products,explicitEdges:edges,deterministicEdges:deterministicMappingEdges(products),candidate});});
  return {
    setup, decisions, familyDecisions, reviewOutcomes,
    async inspectCurrentGraph(history=null){
      const products=await loadProducts(),resolvedHistory=history||await decisions();
      return inspectProductGraph({products,explicitEdges:activeEdges(resolvedHistory),deterministicEdges:deterministicMappingEdges(products)});
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
      const graph=diagnoseProposedProductEdge({products,explicitEdges:activeEdges(history),deterministicEdges:deterministicMappingEdges(products),candidate});
      const endpoints=[candidate.left_ref,candidate.right_ref],sourceRef=endpoints.find(x=>!x.startsWith('shopify:')),parentRef=endpoints.find(x=>x.startsWith('shopify:shopify:'));
      const [schema]=await bigquery.query({query:`SELECT COUNTIF(table_name=@table) present FROM \`${project}.${dataset}.INFORMATION_SCHEMA.TABLES\``,params:{table:PRODUCT_FAMILY_TABLE},useLegacySql:false});
      let families=[];if(Number(schema[0]?.present||0))families=await familyDecisions();const familyState=resolveFamilyDecisions(families),existing=familyState.active.find(x=>x.source_ref===sourceRef);
      return {...graph,family_preview:sourceRef&&parentRef?{relationship_type:'reporting_family_not_identity',source_ref:sourceRef,shopify_parent_ref:parentRef,reporting_product_ref:`family:${parentRef}`,source_identity_preserved:true,canonical_graph_changed:false,would_conflict:Boolean(existing&&existing.shopify_parent_ref!==parentRef),current_parent_ref:existing?.shopify_parent_ref||null,decision_table_present:Boolean(Number(schema[0]?.present||0))}:{available:false,reason:'preview requires one non-Shopify source and one Shopify parent'}};
    },
    async previewChoice(candidateId,selectedRef,sourceRef=null){
      if(!/^[a-f0-9]{24}$/i.test(String(candidateId||''))||String(selectedRef||'').length>200||String(sourceRef||'').length>200)throw new Error('invalid product choice preview request');
      const [products,mappingHistory,familyHistory]=await Promise.all([loadProducts(),decisions(),familyDecisions()]);
      const source=products.find(item=>item.source_product_ref===sourceRef);
      const candidate=(source&&{candidate_id:candidateId,left_ref:source.source_product_ref,right_ref:selectedRef,left_title:source.title,right_title:null,candidate_method:'shopify_parent_suggestion'})||mappingHistory.find(item=>item.candidate_id===candidateId);
      if(!candidate)throw new Error('product mapping candidate was not found');
      const normalizedRef=String(selectedRef).startsWith('shopify:shopify:')?String(selectedRef):`shopify:shopify:${selectedRef}`;
      return buildProductChoicePreview({products,mappingDecisions:mappingHistory,familyDecisions:familyHistory,candidate,selectedRef:normalizedRef});
    },
    async currentState(){return resolveMappingDecisions(await decisions());},
    async list(options={}){return buildList(options);},
    async validateReviewQueue(){return buildList({search:'',ensureSchema:false,diagnostic:true});},
    async search({query='',sources=[],exclude_ref=null,limit=50,products}={}){await setup();const [items,history]=await Promise.all([products?Promise.resolve(products):loadProducts(),decisions()]);return {items:searchProducts(items,{query,sources,excludeRef:exclude_ref,limit,decisions:history}).map(x=>({...x,source_label:productSourceLabel(x)})),limit:Math.min(Number(limit)||50,100)};},
    async history(filters={}){await setup();const products=await loadProducts();const productByRef=new Map(products.map(p=>[p.source_product_ref,p]));const state=resolveMappingDecisions(await decisions());const graph=inspectProductGraph({products,explicitEdges:approvedMappingEdges(state.history)});const conflictIds=new Set(graph.conflict_diagnostics.flatMap(c=>c.decision_ids));let items=state.history.map(d=>({...d,left_product:productByRef.get(d.left_ref)||null,right_product:productByRef.get(d.right_ref)||null,current:state.current.includes(d),graph_conflict:conflictIds.has(d.decision_id||d.event_id),canonical_relationship:d.status==='approved'&&!state.current.includes(d)?'historical':state.activeApproved.includes(d)?'active':'none'}));if(filters.status==='conflicts')items=items.filter(d=>d.graph_conflict);else if(!filters.status)items=items.filter(d=>d.current);else if(filters.status!=='all')items=items.filter(d=>filters.status==='superseded'?state.superseded.includes(d):d.status===filters.status);if(filters.source)items=items.filter(d=>d.left_ref.startsWith(filters.source+':')||d.right_ref.startsWith(filters.source+':'));if(filters.search)items=items.filter(d=>`${d.left_title} ${d.right_title}`.toLowerCase().includes(String(filters.search).toLowerCase()));if(filters.reviewer)items=items.filter(d=>d.reviewed_by===filters.reviewer);if(filters.start_date)items=items.filter(d=>String(d.reviewed_at)>=filters.start_date);if(filters.end_date)items=items.filter(d=>String(d.reviewed_at)<=`${filters.end_date}T23:59:59.999Z`);return {items:items.sort((a,b)=>String(b.reviewed_at).localeCompare(String(a.reviewed_at))),counts:{approved:state.activeApproved.length,rejected:state.activeRejected.length,revoked:state.revoked.length,superseded:state.superseded.length,conflicts:graph.summary.conflicted_components},conflicts:graph.conflict_diagnostics};},
    async familyHistory(){await setup();const state=resolveFamilyDecisions(await familyDecisions());return{items:state.history.map(x=>({...x,relationship_type:'reporting_family',current:state.current.includes(x)})).sort((a,b)=>String(b.reviewed_at).localeCompare(String(a.reviewed_at))),counts:{active:state.active.length,revoked:state.revoked.length,superseded:state.superseded.length}};},
    async review(candidate,status,reviewer,note=null){await setup();if(!['approved','rejected'].includes(status))throw new Error('status must be approved or rejected');const history=await decisions();if(status==='approved')await validateApproval(candidate,activeEdges(history));const [row]=await append([makeDecision(candidate,status,reviewer,{note})]);return row;},
    async chooseCorrect({candidate,selected,note},reviewer){await setup();if(!isShopifyParentProduct(selected))throw new Error('selected product must be a Shopify parent product, not a variant');const sourceRef=[candidate.left_ref,candidate.right_ref].find(ref=>!ref.startsWith('shopify:'));if(!sourceRef)throw new Error('historical source product is required');assertPair({source_product_ref:sourceRef,source_platform:sourceRef.split(':')[0],source_store:sourceRef.split(':')[1]},selected);const history=await decisions();const replacement={left_ref:sourceRef,right_ref:selected.source_product_ref,left_title:sourceRef===candidate.left_ref?candidate.left_title:candidate.right_title,right_title:selected.title,candidate_method:'human_replacement'};await validateApproval(replacement,activeEdges(history));const rejected=makeDecision(candidate,'rejected',reviewer,{note,provenance:'oracle_choose_correct_product'});const approved=makeDecision(replacement,'approved',reviewer,{note,provenance:'oracle_choose_correct_product',replacementFor:rejected.decision_id});await append([rejected,approved]);return {rejected,approved};},
    async createMapping({left,right,note},reviewer){await setup();assertPair(left,right);const pair={left_ref:left.source_product_ref,right_ref:right.source_product_ref,left_title:left.title,right_title:right.title,candidate_method:'human_created'};const history=await decisions();await validateApproval(pair,activeEdges(history));const [approved]=await append([makeDecision(pair,'approved',reviewer,{note,provenance:'oracle_manual_mapping'})]);return {approved};},
    async changeMapping({decision_id,replacement,note},reviewer){await setup();const history=await decisions(),state=resolveMappingDecisions(history),old=state.byId.get(decision_id);if(!old||!state.activeApproved.includes(old))throw new Error('approved mapping is not active');const anchored=old.left_ref===replacement.source_product_ref?old.right_ref:old.left_ref;const replacementPair={left_ref:anchored,right_ref:replacement.source_product_ref,left_title:old.left_ref===anchored?old.left_title:old.right_title,right_title:replacement.title,candidate_method:'human_replacement'};const withoutOld=state.activeApproved.filter(d=>d!==old);await validateApproval(replacementPair,approvedMappingEdges(withoutOld));const revoked=makeDecision(old,'superseded',reviewer,{note,provenance:'oracle_change_mapping',supersedes:decision_id});const approved=makeDecision(replacementPair,'approved',reviewer,{note,provenance:'oracle_change_mapping',replacementFor:decision_id});await append([revoked,approved]);return {superseded:revoked,approved};},
    async revokeMapping({decision_id,note},reviewer){await setup();const state=resolveMappingDecisions(await decisions()),old=state.byId.get(decision_id);if(!old||!state.activeApproved.includes(old))throw new Error('approved mapping is not active');const [revoked]=await append([makeDecision(old,'revoked',reviewer,{note,provenance:'oracle_revoke_mapping',supersedes:decision_id})]);return {revoked};},
    async assignFamily({source,parent,note},reviewer){await setup();const history=await familyDecisions();assertFamilyAssignment(source?.source_product_ref,parent?.source_product_ref,history);const [decision]=await appendFamily([makeFamilyDecision(source,parent,'active',reviewer,{note})]);return{decision};},
    async bulkReview({decisions:requests=[]}={},reviewer){
      await setup();if(!Array.isArray(requests)||!requests.length||requests.length>100)throw new Error('bulk decisions must contain 1 to 100 rows');
      const results=[];
      for(let index=0;index<requests.length;index++){
        const request=requests[index]||{},requestId=String(request.request_id||'');
        try{
          if(!requestId||requestId.length>128)throw new Error('request_id is required for idempotent retry');
          if(!['identity','family','no_equivalent','needs_investigation'].includes(request.action))throw new Error('invalid review action');
          const [products,mappingHistory,familyHistory,outcomeHistory]=await Promise.all([loadProducts(),decisions(),familyDecisions(),reviewOutcomes()]);
          const source=products.find(x=>x.source_product_ref===request.source_ref);if(!source||source.source_product_ref.startsWith('shopify:'))throw new Error('historical source product was not found');
          const idStatus=request.action==='identity'?'approved':request.action==='family'?'active':request.action;
          const eventId=stableId(requestId,`${idStatus}:${request.source_ref}:${request.shopify_parent_ref||''}`);
          const already=[...mappingHistory,...familyHistory,...outcomeHistory].find(x=>(x.decision_id||x.event_id)===eventId||x.event_id===eventId);
          if(already){results.push({index,request_id:requestId,status:'succeeded',idempotent:true,event_id:eventId});continue;}
          if(request.action==='no_equivalent'||request.action==='needs_investigation'){
            const row={event_id:eventId,source_ref:source.source_product_ref,source_title:source.title||null,outcome:request.action,reviewed_by:reviewer,reviewed_at:new Date().toISOString(),provenance:'oracle_product_mapping_bulk_review',note:sanitizeReviewerNote(request.note),request_id:requestId};await appendOutcome(row);results.push({index,request_id:requestId,status:'succeeded',action:request.action,event_id:eventId});continue;
          }
          const parent=products.find(x=>x.source_product_ref===request.shopify_parent_ref);if(!parent||!isShopifyParentProduct(parent))throw new Error('selected product must be a Shopify parent product, not a variant');
          const candidate={candidate_id:relationshipId(source.source_product_ref,parent.source_product_ref),left_ref:source.source_product_ref,right_ref:parent.source_product_ref,left_title:source.title,right_title:parent.title};
          const preview=buildProductChoicePreview({products,mappingDecisions:mappingHistory,familyDecisions:familyHistory,candidate,selectedRef:parent.source_product_ref});
          if(request.preview_token&&request.preview_token!==preview.preview_token)throw new Error('stale preview; review the current allowed/blocked result and retry');
          if(request.action==='identity'){
            if(!preview.identity_preview.allowed)throw new Error(`identity blocked: ${preview.identity_preview.reason||'current graph rules reject this mapping'}`);
            await validateApproval(candidate,activeEdges(mappingHistory));const row=makeDecision(candidate,'approved',reviewer,{note:request.note,provenance:'oracle_product_mapping_bulk_review',requestId});await append([row]);results.push({index,request_id:requestId,status:'succeeded',action:'identity',event_id:row.event_id});
          }else{
            if(!preview.family_preview.allowed)throw new Error(`family blocked: ${preview.family_preview.reason}`);
            assertFamilyAssignment(source.source_product_ref,parent.source_product_ref,familyHistory);const row=makeFamilyDecision(source,parent,'active',reviewer,{note:request.note,provenance:'oracle_product_mapping_bulk_review',requestId});await appendFamily([row]);results.push({index,request_id:requestId,status:'succeeded',action:'family',event_id:row.event_id});
          }
        }catch(error){results.push({index,request_id:requestId||null,status:'failed',action:request.action||null,error:error.message});}
      }
      return{results,succeeded:results.filter(x=>x.status==='succeeded').length,failed:results.filter(x=>x.status==='failed').length};
    },
    async changeFamily({decision_id,parent,note},reviewer){await setup();if(!parent?.source_product_ref?.startsWith('shopify:shopify:'))throw new Error('Shopify parent is required');const state=resolveFamilyDecisions(await familyDecisions()),old=state.byId.get(decision_id);if(!old||!state.active.includes(old))throw new Error('family membership is not active');if(old.shopify_parent_ref===parent.source_product_ref)throw new Error('relationship is already an active family membership');const source={source_product_ref:old.source_ref,title:old.source_title};const superseded=makeFamilyDecision(source,{source_product_ref:old.shopify_parent_ref,title:old.shopify_parent_title},'superseded',reviewer,{note,provenance:'oracle_change_product_family',supersedes:decision_id});const replacement=makeFamilyDecision(source,parent,'active',reviewer,{note,provenance:'oracle_change_product_family',replacementFor:decision_id});await appendFamily([superseded,replacement]);return{superseded,replacement};},
    async revokeFamily({decision_id,note},reviewer){await setup();const state=resolveFamilyDecisions(await familyDecisions()),old=state.byId.get(decision_id);if(!old||!state.active.includes(old))throw new Error('family membership is not active');const source={source_product_ref:old.source_ref,title:old.source_title},parent={source_product_ref:old.shopify_parent_ref,title:old.shopify_parent_title};const [revoked]=await appendFamily([makeFamilyDecision(source,parent,'revoked',reviewer,{note,provenance:'oracle_revoke_product_family',supersedes:decision_id})]);return{revoked};},
    async reconsider({decision_id,approve=false,note},reviewer){await setup();const state=resolveMappingDecisions(await decisions()),old=state.byId.get(decision_id);if(!old||old.status!=='rejected')throw new Error('rejected decision was not found');if(approve)await validateApproval(old,activeEdges(state.history));const [decision]=await append([makeDecision(old,approve?'approved':'reconsidered',reviewer,{note,provenance:'oracle_reconsider_rejection',supersedes:decision_id})]);return {decision};}
  };
}

import { randomUUID } from 'node:crypto';

export const KNOWLEDGE_STATUSES = ['confirmed', 'working', 'rejected', 'superseded'];
export const SOURCE_TYPES = ['human_entered', 'business_document', 'governed_data_analysis', 'system_definition', 'external_source'];
export const MEMORY_TYPES = ['finding', 'decision', 'explanation', 'hypothesis', 'rejected_hypothesis', 'data_quality_issue', 'reporting_convention'];
export const DATE_PRECISIONS = ['day', 'range', 'month', 'year', 'unknown'];
export const KNOWLEDGE_KINDS = ['fact', 'event', 'definition'];
export const MAX_RETRIEVAL_LIMIT = 50;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^(kn|ev|df|mem)_[0-9a-f-]{16,}$/;
const PROHIBITED_KEYS = /(email|phone|password|secret|payment|card|address|postcode|postal|customer_name|employee)/i;

function assertDate(value, name) {
  if (value == null) return;
  if (typeof value !== 'string' || !DATE.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be null or a valid YYYY-MM-DD date`);
  }
}
function text(value, name, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters`);
}
function optionalText(value, name, max = 1000) { if (value != null) text(value, name, max); }
function checkPrivacy(value, path = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (PROHIBITED_KEYS.test(key)) throw new Error(`prohibited PII-like field: ${path}${key}`);
    checkPrivacy(child, `${path}${key}.`);
  }
}
function validateCommon(item, prefix) {
  if (item.id != null && (!ID.test(item.id) || !item.id.startsWith(prefix))) throw new Error(`id must be an opaque ${prefix} identifier`);
  if (!KNOWLEDGE_STATUSES.includes(item.status)) throw new Error(`invalid status: ${item.status}`);
  if (!SOURCE_TYPES.includes(item.source_type)) throw new Error(`invalid source_type: ${item.source_type}`);
  text(item.source_reference, 'source_reference', 1000);
  text(item.created_by, 'created_by', 200);
  assertDate(item.effective_from, 'effective_from'); assertDate(item.effective_to, 'effective_to');
  if (item.effective_from && item.effective_to && item.effective_from > item.effective_to) throw new Error('effective_from must be on or before effective_to');
  if (item.supersedes != null && !ID.test(item.supersedes)) throw new Error('supersedes must be an opaque ID');
  if (item.tags != null && (!Array.isArray(item.tags) || item.tags.length > 20 || item.tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 100))) throw new Error('tags must contain at most 20 non-empty strings of at most 100 characters');
  checkPrivacy(item);
}

export function validateKnowledgeItem(kind, input) {
  if (!KNOWLEDGE_KINDS.includes(kind)) throw new Error(`invalid knowledge kind: ${kind}`);
  const prefix = { fact: 'kn_', event: 'ev_', definition: 'df_' }[kind];
  const item = { status: 'confirmed', effective_from: null, effective_to: null, supersedes: null, tags: [], ...input };
  validateCommon(item, prefix);
  if (kind === 'fact') { text(item.subject, 'subject', 300); text(item.predicate, 'predicate', 200); text(item.statement, 'statement'); }
  if (kind === 'event') {
    text(item.event_type, 'event_type', 100); text(item.title, 'title', 300); text(item.description, 'description');
    if (!DATE_PRECISIONS.includes(item.date_precision)) throw new Error('invalid date_precision');
    if (item.date_precision === 'unknown' && (item.effective_from || item.effective_to)) throw new Error('unknown date precision cannot include dates');
    if (item.date_precision !== 'unknown' && !item.effective_from) throw new Error('dated events require effective_from');
  }
  if (kind === 'definition') { text(item.term, 'term', 300); text(item.definition, 'definition'); text(item.implementation_reference, 'implementation_reference', 1000); }
  return { ...item, id: item.id || `${prefix}${randomUUID()}` };
}

export function validateMemory(input) {
  const item = { status: 'working', effective_from: null, effective_to: null, supersedes: null, tags: [], evidence: [], ...input };
  validateCommon(item, 'mem_'); text(item.title, 'title', 300); text(item.statement, 'statement');
  if (!MEMORY_TYPES.includes(item.memory_type)) throw new Error('invalid memory_type');
  if (!Array.isArray(item.evidence) || item.evidence.length === 0) throw new Error('memory evidence is required');
  for (const evidence of item.evidence) { text(evidence.reference, 'evidence.reference', 1000); text(evidence.kind, 'evidence.kind', 100); }
  if (item.status === 'confirmed' && item.memory_type === 'hypothesis') throw new Error('a hypothesis cannot be confirmed without changing its memory_type');
  if (item.confidence != null && (typeof item.confidence !== 'number' || item.confidence < 0 || item.confidence > 1)) throw new Error('confidence must be null or between 0 and 1');
  return { ...item, id: item.id || `mem_${randomUUID()}` };
}

export function overlaps(item, start, end) {
  return (!item.effective_from || item.effective_from <= end) && (!item.effective_to || item.effective_to >= start);
}
export function rankItem(item, historical = false) {
  const status = { confirmed: 0, working: 30, rejected: 80, superseded: 90 }[item.status] ?? 100;
  const kind = { definition: 0, fact: 10, event: 10, memory: 20 }[item.kind] ?? 20;
  return kind + status + ((!historical && item.status === 'superseded') ? 100 : 0);
}
export function selectContext(items, { start_date, end_date, topics = [], include_historical = false, limit = 20 }) {
  assertDate(start_date, 'start_date'); assertDate(end_date, 'end_date');
  if (!start_date || !end_date || start_date > end_date) throw new Error('an ordered context date range is required');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RETRIEVAL_LIMIT) throw new Error('invalid limit');
  const requested = topics.map(topic => topic.toLowerCase());
  return items.filter(item => overlaps(item, start_date, end_date))
    .filter(item => include_historical || !['rejected', 'superseded'].includes(item.status))
    .filter(item => !requested.length || (item.tags || []).some(tag => requested.includes(tag.toLowerCase())) || requested.some(topic => JSON.stringify(item).toLowerCase().includes(topic)))
    .sort((a, b) => rankItem(a, include_historical) - rankItem(b, include_historical) || a.id.localeCompare(b.id)).slice(0, limit);
}

export function validateCollection(items) {
  const ids = new Set(); const byId = new Map();
  for (const raw of items) { const item = raw.kind === 'memory' ? validateMemory(raw) : validateKnowledgeItem(raw.kind, raw); if (ids.has(item.id)) throw new Error(`duplicate ID: ${item.id}`); ids.add(item.id); byId.set(item.id, {...item,kind:raw.kind}); }
  for (const item of byId.values()) if (item.supersedes && !byId.has(item.supersedes)) throw new Error(`missing supersedes target: ${item.supersedes}`);
  const activeDefinitions = [...byId.values()].filter(x => x.kind === 'definition' && x.status !== 'superseded' && x.status !== 'rejected');
  for (let i=0;i<activeDefinitions.length;i++) for(let j=i+1;j<activeDefinitions.length;j++) { const a=activeDefinitions[i],b=activeDefinitions[j]; if(a.term.toLowerCase()===b.term.toLowerCase() && overlaps(a,b.effective_from||'0001-01-01',b.effective_to||'9999-12-31')) throw new Error(`contradictory active definition: ${a.term}`); }
  return {valid:true,records:items.length,ids:[...ids]};
}

const nullableString = { type: ['string', 'null'] };
export const KNOWLEDGE_TOOL_DEFINITIONS = [
  { type:'function', name:'search_knowledge', strict:true, description:'Search bounded structured governed facts, events and definitions. Superseded/rejected records are excluded unless explicitly requested.', parameters:{type:'object',additionalProperties:false,properties:{text:nullableString,knowledge_type:{type:['string','null'],enum:['fact','event','definition',null]},start_date:nullableString,end_date:nullableString,status:{type:['string','null'],enum:[...KNOWLEDGE_STATUSES,null]},tags:{type:'array',items:{type:'string'},maxItems:10},limit:{type:'integer',minimum:1,maximum:50}},required:['text','knowledge_type','start_date','end_date','status','tags','limit']} },
  { type:'function', name:'get_business_context', strict:true, description:'Retrieve governed facts, events and definitions overlapping an analytical period. Call before comparing named campaigns or explaining historical changes.', parameters:{type:'object',additionalProperties:false,properties:{start_date:{type:'string'},end_date:{type:'string'},topics:{type:'array',items:{type:'string'},maxItems:10}},required:['start_date','end_date','topics']} },
  { type:'function', name:'get_knowledge_item', strict:true, description:'Retrieve one exact governed knowledge item by opaque ID.', parameters:{type:'object',additionalProperties:false,properties:{knowledge_id:{type:'string'}},required:['knowledge_id']} },
  { type:'function', name:'search_memory', strict:true, description:'Search bounded durable findings and decisions. Working hypotheses are labelled; rejected/superseded records are excluded by default and memory never overrides live governed metrics.', parameters:{type:'object',additionalProperties:false,properties:{text:nullableString,start_date:nullableString,end_date:nullableString,status:{type:['string','null'],enum:[...KNOWLEDGE_STATUSES,null]},memory_type:{type:['string','null'],enum:[...MEMORY_TYPES,null]},tags:{type:'array',items:{type:'string'},maxItems:10},limit:{type:'integer',minimum:1,maximum:50}},required:['text','start_date','end_date','status','memory_type','tags','limit']} },
  { type:'function', name:'get_memory_item', strict:true, description:'Retrieve one exact durable memory record with status and evidence.', parameters:{type:'object',additionalProperties:false,properties:{memory_id:{type:'string'}},required:['memory_id']} }
];

export function assertAgentReadOnly() {
  const names = KNOWLEDGE_TOOL_DEFINITIONS.map(tool => tool.name);
  if (names.some(name => /record|write|create|update|delete|propose/.test(name))) throw new Error('write tool exposed to /agent');
  return { valid: true, exposed_tools: names, memory_write_exposed: false };
}

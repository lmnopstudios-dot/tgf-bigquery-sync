import crypto from 'node:crypto';
import { validateKnowledgeItem, validateMemory } from './knowledge.js';

const nullableString = { type: ['string', 'null'] };
const boundedString = maxLength => ({ type: 'string', maxLength });
const common = {
  status: { type: 'string', enum: ['confirmed', 'working', 'rejected'] },
  source_type: { type: 'string', enum: ['human_entered', 'business_document', 'governed_data_analysis', 'system_definition', 'external_source'] },
  source_reference: boundedString(1000),
  effective_from: nullableString, effective_to: nullableString,
  supersedes: nullableString,
  tags: { type: 'array', items: boundedString(100), maxItems: 20 }
};
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const variants = [
  object({ kind: { type: 'string', enum: ['event'] }, event_type: boundedString(100), title: boundedString(300), description: boundedString(4000), date_precision: { type: 'string', enum: ['day', 'range', 'month', 'year', 'unknown'] }, ...common }),
  object({ kind: { type: 'string', enum: ['fact'] }, subject: boundedString(300), predicate: boundedString(200), statement: boundedString(4000), ...common }),
  object({ kind: { type: 'string', enum: ['definition'] }, term: boundedString(300), definition: boundedString(4000), implementation_reference: boundedString(1000), ...common }),
  object({ kind: { type: 'string', enum: ['memory'] }, memory_type: { type: 'string', enum: ['finding', 'decision', 'explanation', 'hypothesis', 'rejected_hypothesis', 'data_quality_issue', 'reporting_convention'] }, title: boundedString(300), statement: boundedString(4000), confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 }, evidence: { type: 'array', minItems: 1, maxItems: 20, items: object({ kind: boundedString(100), reference: boundedString(1000) }) }, ...common })
];

export const PROPOSE_GOVERNED_RECORDS_TOOL = {
  type: 'function', name: 'propose_governed_records', strict: true,
  description: 'Return zero or more non-writing governed record candidates. This tool cannot persist anything.',
  // Strict Responses function schemas support `anyOf`; `oneOf` is rejected by the API.
  parameters: object({ proposals: { type: 'array', maxItems: 12, items: { anyOf: variants } } })
};

// The Responses API validates strict function schemas before running the model.
// Keep this independent of mocks so an implicit property or array item fails at
// process startup rather than after deployment. `anyOf` is the only untyped
// composition node used here; every concrete value schema declares its type.
export function assertStrictToolSchema(schema = PROPOSE_GOVERNED_RECORDS_TOOL.parameters) {
  const supportedTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  const visit = (node, path) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`${path} must be a schema object`);
    if (!Object.hasOwn(node, 'type') && !Array.isArray(node.anyOf)) throw new Error(`${path} must declare type or anyOf`);
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (Object.hasOwn(node, 'type') && (!types.length || types.some(type => !supportedTypes.has(type)))) throw new Error(`${path}.type is not supported`);
    if (node.anyOf) {
      if (!node.anyOf.length) throw new Error(`${path}.anyOf must not be empty`);
      node.anyOf.forEach((branch, index) => visit(branch, `${path}.anyOf[${index}]`));
    }
    if (node.type === 'object') {
      if (!node.properties || node.additionalProperties !== false) throw new Error(`${path} must be a closed object schema`);
      const names = Object.keys(node.properties);
      if (!Array.isArray(node.required) || new Set(node.required).size !== node.required.length || names.some(name => !node.required.includes(name)) || node.required.some(name => !names.includes(name))) throw new Error(`${path}.required must contain every property exactly`);
      for (const [name, child] of Object.entries(node.properties)) visit(child, `${path}.properties.${name}`);
    }
    if (node.type === 'array') {
      if (!node.items) throw new Error(`${path}.items is required`);
      visit(node.items, `${path}.items`);
    }
    if (Array.isArray(node.type) && (node.type.length < 2 || new Set(node.type).size !== node.type.length || !node.type.includes('null'))) throw new Error(`${path}.type must be an explicit nullable union`);
    if (node.enum && node.enum.some(value => value === null ? !types.includes('null') : !types.includes(typeof value))) throw new Error(`${path}.enum must match its declared type`);
  };
  visit(schema, 'parameters');
  return true;
}

assertStrictToolSchema();

export const PROPOSAL_INSTRUCTIONS = `You structure durable business assertions into a small, useful set of governed record proposals. You never save or write anything. An explicit request to save is not required: an ordinary brief may contain durable assertions worth proposing for human review.
Return an empty proposals list for questions, comparisons, analytical requests, casual conversation, or text without new durable assertions. A persistence request strengthens intent but never authorizes a write. For mixed input, propose only assertions.
Compare every candidate with the supplied existing governed records. Omit an equivalent existing claim. When the same subject or titled event has materially changed, propose the changed claim and set supersedes to the exact existing record ID so the UI presents a linked update.
Preserve material dates, times, offers, exclusions, qualifications, and provenance. Prefer a campaign record plus channel/store/cutoff records when that aids future retrieval; do not make dozens of micro-records. DATE fields are YYYY-MM-DD; retain time-of-day in descriptions.
Use business_document only when the user clearly identifies pasted email/document content, with a concise non-fabricated reference; otherwise human_entered. Never invent metadata.
Uncertain assertions must be working hypotheses (memory kind, memory_type hypothesis) or omitted, never confirmed. Confirmed memories require governed evidence references; user attestation alone supports only working memory. Do not include chain-of-thought or raw tool output.
Do not infer causation. In particular, chronology about made-to-order Christmas delivery is context, not a cause of sales.
Titles must be concise descriptions, never raw instructions/questions. Use only schema fields. supersedes must be null unless an exact supplied governed record makes the relationship deterministic.`;

export function needsProposalGeneration(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  if (/\b(?:save|remember|record|store|add)\b/i.test(text)) return true;
  // This deliberately recognizes only obvious, wholly non-assertive requests. It
  // does not attempt extraction; everything ambiguous is left to the model.
  const sentences = text.split(/(?<=[?.!])\s+/).filter(Boolean);
  if (sentences.length > 1) return !sentences.every(sentence => !needsProposalGeneration(sentence));
  if (/^(?:what|why|when|where|who|whom|whose|which|how|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had)\b[\s\S]*\?$/i.test(text)) return false;
  if (/^(?:compare|contrast|analyse|analyze|explain|evaluate|summari[sz]e|calculate|show|list|tell me)\b/i.test(text)) return false;
  if (/^(?:hello|hi|hey|thanks|thank you)[!.]?$/i.test(text)) return false;
  return true;
}

function proposalError(error, phase) {
  const wrapped = new Error(error?.message || 'Proposal generation failed');
  wrapped.name = 'ProposalGenerationError';
  wrapped.phase = phase;
  wrapped.status = error?.status;
  wrapped.code = error?.code;
  wrapped.openaiType = error?.type || error?.error?.type;
  wrapped.providerErrorClass = error?.constructor?.name;
  return wrapped;
}

export function proposalDiagnostic(error, model) {
  const hasProviderMetadata = Number.isInteger(error?.status) || error?.code || error?.openaiType;
  const raw = String(hasProviderMetadata ? error?.message : 'Proposal generation failed')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:payload|input|request body)\s*[=:]\s*\{.*$/gi, 'payload=[REDACTED]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);
  return {
    operation: 'proposal_generation', phase: error?.phase || 'proposal_validation', model,
    error_class: error?.providerErrorClass || error?.constructor?.name || 'Error',
    ...(Number.isInteger(error?.status) ? { http_status: error.status } : {}),
    ...(error?.code ? { openai_code: String(error.code).slice(0, 80) } : {}),
    ...(error?.openaiType ? { openai_type: String(error.openaiType).slice(0, 80) } : {}),
    message: raw
  };
}

export function createProposalGenerator({ openai, model = 'gpt-5.6' }) {
  if (!openai?.responses?.create) throw new Error('an OpenAI responses client is required');
  return async ({ message, existing = [], evidence = [] }) => {
    if (!needsProposalGeneration(message)) return [];
    const context = existing.slice(0, 20).map(item => ({ id: item.id, kind: item.kind, status: item.status, title: item.title || item.term || item.subject, content: item.content || item.description || item.definition || item.statement }));
    let response;
    try {
      response = await openai.responses.create({ model, instructions: PROPOSAL_INSTRUCTIONS, input: JSON.stringify({ user_message: message, existing_governed_records: context, governed_evidence_references: evidence.slice(0, 20) }), tools: [PROPOSE_GOVERNED_RECORDS_TOOL], tool_choice: { type: 'function', name: 'propose_governed_records' }, parallel_tool_calls: false, max_output_tokens: 6000 });
    } catch (error) { throw proposalError(error, 'openai_request'); }
    try {
      const call = response.output?.find(item => item.type === 'function_call' && item.name === 'propose_governed_records');
      if (!call) throw new Error('proposal model returned no structured proposal call');
      const parsed = JSON.parse(call.arguments || '{}');
      if (!Array.isArray(parsed.proposals)) throw new Error('proposal model returned an invalid proposal list');
      return parsed.proposals;
    } catch (error) { throw proposalError(error, 'response_parse'); }
  };
}

const comparable = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const contentOf = value => value.description || value.definition || value.statement || '';
const allowedFields = {
  fact: ['id', 'subject', 'predicate', 'statement'], event: ['id', 'event_type', 'title', 'description', 'date_precision'],
  definition: ['id', 'term', 'definition', 'implementation_reference'], memory: ['id', 'memory_type', 'title', 'statement', 'confidence', 'evidence']
};
const commonFields = ['status', 'source_type', 'source_reference', 'created_by', 'effective_from', 'effective_to', 'supersedes', 'tags'];
function rejectArbitraryFields(kind, proposal) {
  const allowed = new Set([...commonFields, ...(allowedFields[kind] || [])]);
  for (const key of Object.keys(proposal || {})) if (!allowed.has(key)) throw new Error(`invalid proposal field: ${key}`);
}
export function isDuplicateProposal(wrapper, existing = []) {
  const candidate = comparable(contentOf(wrapper?.proposal || {}));
  return existing.some(item => ['confirmed', 'working', undefined].includes(item.status) && candidate && comparable(item.content || contentOf(item)) === candidate);
}

export function normalizeModelProposal(candidate, { createdBy = 'oracle-ui', existing = [] } = {}) {
  if (!candidate || !['fact', 'event', 'definition', 'memory'].includes(candidate.kind)) throw new Error('invalid proposal kind');
  const { kind, ...fields } = candidate;
  rejectArbitraryFields(kind, fields);
  const proposal = kind === 'memory' ? validateMemory({ ...fields, created_by: createdBy }) : validateKnowledgeItem(kind, { ...fields, created_by: createdBy });
  const wrapper = { proposal_id: crypto.randomUUID(), kind, proposal, uncertain: proposal.status === 'working', persisted: false, approval_required: true, validity: 'valid' };
  if (isDuplicateProposal(wrapper, existing)) return { ...wrapper, validity: 'already_known', saveable: false };
  const sameTitle = existing.find(item => item.kind === kind && ['confirmed','working',undefined].includes(item.status) && comparable(item.title || item.term || item.subject) === comparable(proposal.title || proposal.term || proposal.subject));
  if (!proposal.supersedes && sameTitle && /^(?:kn|ev|df|mem)_[0-9a-f-]{16,}$/.test(sameTitle.id || '')) proposal.supersedes = sameTitle.id;
  return { ...wrapper, saveable: true };
}

export function invalidProposal(candidate) {
  return { proposal_id: crypto.randomUUID(), kind: ['fact', 'event', 'definition', 'memory'].includes(candidate?.kind) ? candidate.kind : 'fact', proposal: candidate || {}, persisted: false, approval_required: true, validity: 'invalid', saveable: false, validation_error: 'This proposal requires editing before it can be saved.' };
}
export function proposalSearchText(wrapper) { return contentOf(wrapper?.proposal || {}); }
export function validateApprovedProposal(kind, proposal) { rejectArbitraryFields(kind, proposal); return kind === 'memory' ? validateMemory(proposal) : validateKnowledgeItem(kind, proposal); }

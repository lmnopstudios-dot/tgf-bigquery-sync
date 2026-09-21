import crypto from 'node:crypto';
import { validateKnowledgeItem, validateMemory } from './knowledge.js';

const nullableString = { type: ['string', 'null'] };
const common = {
  status: { type: 'string', enum: ['confirmed', 'working', 'rejected'] },
  source_type: { type: 'string', enum: ['human_entered', 'business_document', 'governed_data_analysis', 'system_definition', 'external_source'] },
  source_reference: { type: 'string', maxLength: 1000 },
  effective_from: nullableString, effective_to: nullableString,
  supersedes: nullableString,
  tags: { type: 'array', items: { type: 'string' }, maxItems: 20 }
};
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const variants = [
  object({ kind: { const: 'event' }, event_type: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, date_precision: { type: 'string', enum: ['day', 'range', 'month', 'year', 'unknown'] }, ...common }),
  object({ kind: { const: 'fact' }, subject: { type: 'string' }, predicate: { type: 'string' }, statement: { type: 'string' }, ...common }),
  object({ kind: { const: 'definition' }, term: { type: 'string' }, definition: { type: 'string' }, implementation_reference: { type: 'string' }, ...common }),
  object({ kind: { const: 'memory' }, memory_type: { type: 'string', enum: ['finding', 'decision', 'explanation', 'hypothesis', 'rejected_hypothesis', 'data_quality_issue', 'reporting_convention'] }, title: { type: 'string' }, statement: { type: 'string' }, confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 }, evidence: { type: 'array', maxItems: 20, items: object({ kind: { type: 'string' }, reference: { type: 'string' } }) }, ...common })
];

export const PROPOSE_GOVERNED_RECORDS_TOOL = {
  type: 'function', name: 'propose_governed_records', strict: true,
  description: 'Return zero or more non-writing governed record candidates. This tool cannot persist anything.',
  parameters: object({ proposals: { type: 'array', maxItems: 12, items: { oneOf: variants } } })
};

export const PROPOSAL_INSTRUCTIONS = `You structure durable business assertions into a small, useful set of governed record proposals. You never save or write anything.
Return an empty proposals list for questions, comparisons, analytical requests, casual conversation, or text without new durable assertions. A persistence request strengthens intent but never authorizes a write. For mixed input, propose only assertions.
Preserve material dates, times, offers, exclusions, qualifications, and provenance. Prefer a campaign record plus channel/store/cutoff records when that aids future retrieval; do not make dozens of micro-records. DATE fields are YYYY-MM-DD; retain time-of-day in descriptions.
Use business_document only when the user clearly identifies pasted email/document content, with a concise non-fabricated reference; otherwise human_entered. Never invent metadata.
Uncertain assertions must be working hypotheses (memory kind, memory_type hypothesis) or omitted, never confirmed. Confirmed memories require governed evidence references; user attestation alone supports only working memory. Do not include chain-of-thought or raw tool output.
Do not infer causation. In particular, chronology about made-to-order Christmas delivery is context, not a cause of sales.
Titles must be concise descriptions, never raw instructions/questions. Use only schema fields. supersedes must be null unless an exact supplied governed record makes the relationship deterministic.`;

export function createProposalGenerator({ openai, model = 'gpt-5.6' }) {
  if (!openai?.responses?.create) throw new Error('an OpenAI responses client is required');
  return async ({ message, existing = [], evidence = [] }) => {
    const context = existing.slice(0, 20).map(item => ({ id: item.id, kind: item.kind, status: item.status, title: item.title || item.term || item.subject, content: item.content || item.description || item.definition || item.statement }));
    const response = await openai.responses.create({ model, instructions: PROPOSAL_INSTRUCTIONS, input: JSON.stringify({ user_message: message, existing_governed_records: context, governed_evidence_references: evidence.slice(0, 20) }), tools: [PROPOSE_GOVERNED_RECORDS_TOOL], tool_choice: { type: 'function', name: 'propose_governed_records' }, max_output_tokens: 6000 });
    const call = response.output?.find(item => item.type === 'function_call' && item.name === 'propose_governed_records');
    if (!call) throw new Error('proposal model returned no structured proposal call');
    const parsed = JSON.parse(call.arguments || '{}');
    if (!Array.isArray(parsed.proposals)) throw new Error('proposal model returned an invalid proposal list');
    return parsed.proposals;
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
  const sameTitle = existing.find(item => comparable(item.title || item.term || item.subject) === comparable(proposal.title || proposal.term || proposal.subject));
  if (!proposal.supersedes && sameTitle && /^(?:kn|ev|df|mem)_[0-9a-f-]{16,}$/.test(sameTitle.id || '')) proposal.supersedes = sameTitle.id;
  return { ...wrapper, saveable: true };
}

export function invalidProposal(candidate) {
  return { proposal_id: crypto.randomUUID(), kind: ['fact', 'event', 'definition', 'memory'].includes(candidate?.kind) ? candidate.kind : 'fact', proposal: candidate || {}, persisted: false, approval_required: true, validity: 'invalid', saveable: false, validation_error: 'This proposal requires editing before it can be saved.' };
}
export function proposalSearchText(wrapper) { return contentOf(wrapper?.proposal || {}); }
export function validateApprovedProposal(kind, proposal) { rejectArbitraryFields(kind, proposal); return kind === 'memory' ? validateMemory(proposal) : validateKnowledgeItem(kind, proposal); }

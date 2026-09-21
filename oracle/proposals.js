import crypto from 'node:crypto';
import { validateKnowledgeItem, validateMemory } from './knowledge.js';

const uncertain = /\b(i think|maybe|might|perhaps|not (?:sure|certain)|possibly|around)\b/i;
const durable = /\b(remember|save this|important context|launched|campaign|promotion|offer|means|defined as|policy|participat|changed|started|ended|finding|investigation found)\b/i;
const MONTHS = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
const isoDates = text => {
  const values = [...text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map(match => match[1]);
  for (const match of text.matchAll(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/gi)) {
    values.push(`${match[3]}-${String(MONTHS[match[2].toLowerCase()]).padStart(2, '0')}-${match[1].padStart(2, '0')}`);
  }
  return [...new Set(values)];
};
const compact = text => text.trim().replace(/\s+/g, ' ').slice(0, 4000);

export function proposeFromMessage(message, { createdBy = 'oracle-ui', tools = [], now = new Date() } = {}) {
  if (typeof message !== 'string' || !durable.test(message)) return null;
  const source_reference = `Oracle UI user message ${crypto.createHash('sha256').update(message).digest('hex').slice(0, 12)} at ${now.toISOString()}`;
  const status = uncertain.test(message) ? 'working' : 'confirmed';
  const dates = isoDates(message);
  const common = { status, source_type: 'human_entered', source_reference, created_by: createdBy, supersedes: null, tags: [], effective_from: dates[0] || null, effective_to: dates[1] || dates[0] || null };
  let kind = 'fact';
  let proposal;
  if (/\b(finding|investigation found|remember this finding)\b/i.test(message)) {
    kind = 'memory';
    const evidenceBacked = tools.length > 0;
    proposal = validateMemory({ ...common, status: status === 'confirmed' && evidenceBacked ? 'confirmed' : 'working', source_type: evidenceBacked ? 'governed_data_analysis' : 'human_entered', title: compact(message).slice(0, 140), statement: compact(message), memory_type: status === 'confirmed' && evidenceBacked ? 'finding' : 'hypothesis', evidence: evidenceBacked ? tools.map(reference => ({ kind: 'governed_tool', reference })).slice(0, 20) : [{ kind: 'user_attestation', reference: source_reference }] });
  } else if (/\bmeans|defined as\b/i.test(message)) {
    kind = 'definition';
    const term = compact(message).split(/\bmeans|defined as\b/i)[0].replace(/^remember (?:that )?/i, '').trim();
    proposal = validateKnowledgeItem(kind, { ...common, term: term || 'Business term', definition: compact(message), implementation_reference: 'Oracle UI human-entered definition' });
  } else if (dates.length || /\b(campaign|promotion|launched|started|ended)\b/i.test(message)) {
    kind = 'event';
    proposal = validateKnowledgeItem(kind, { ...common, event_type: /campaign|promotion|offer/i.test(message) ? 'campaign' : 'business_event', title: compact(message).slice(0, 140), description: compact(message), date_precision: dates.length > 1 ? 'range' : dates.length === 1 ? 'day' : 'unknown' });
  } else {
    proposal = validateKnowledgeItem(kind, { ...common, subject: 'Business context', predicate: 'states', statement: compact(message) });
  }
  return { proposal_id: crypto.randomUUID(), kind, proposal, uncertain: status === 'working', persisted: false };
}

export function validateApprovedProposal(kind, proposal) {
  if (kind === 'memory') return validateMemory(proposal);
  return validateKnowledgeItem(kind, proposal);
}

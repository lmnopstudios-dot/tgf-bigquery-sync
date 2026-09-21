import crypto from 'node:crypto';
import { validateKnowledgeItem, validateMemory } from './knowledge.js';

const uncertain = /\b(i think|maybe|might|perhaps|not (?:sure|certain)|possibly|approximately|around)\b/i;
const persistenceIntent = /^(?:please\s+)?(?:remember(?:\s+that|\s+this)?|save\s+(?:this\s+)?as\s+business\s+knowledge|add\s+this\s+to\s+oracle(?:'s|’s)\s+knowledge|this\s+is\s+important\s+context\s+for\s+future\s+analysis)\b[\s:,-]*/i;
const assertionVerb = /\b(?:is|are|was|were|ran|run|offered|used|using|launched|started|ended|changed|means|defined as|participated|included|excluded|applies|applied|found|improved|increased|decreased)\b/i;
const interrogative = /^(?:what|when|where|who|why|how|which|did|do|does|is|are|was|were|can|could|would|should|tell me|compare|explain)\b/i;
const MONTHS = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
const compact = text => text.trim().replace(/\s+/g, ' ').replace(/^[,;:\s]+|[,;:\s]+$/g, '').slice(0, 4000);

function assertedText(message) {
  const explicit = persistenceIntent.test(message.trim());
  const cleaned = message.trim().replace(persistenceIntent, '');
  const statements = cleaned.split(/(?<=[.!?])\s+/).map(compact).filter(Boolean)
    .filter(part => !part.includes('?') && !interrogative.test(part) && assertionVerb.test(part));
  return { assertion: compact(statements.join(' ')) || null, explicit };
}
const isoDates = text => {
  const values = [...text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map(match => match[1]);
  for (const match of text.matchAll(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/gi)) values.push(`${match[3]}-${String(MONTHS[match[2].toLowerCase()]).padStart(2, '0')}-${match[1].padStart(2, '0')}`);
  for (const match of text.matchAll(/\b(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/gi)) { const month=String(MONTHS[match[3].toLowerCase()]).padStart(2,'0'); values.push(`${match[4]}-${month}-${match[1].padStart(2,'0')}`,`${match[4]}-${month}-${match[2].padStart(2,'0')}`); }
  return [...new Set(values)].sort();
};
function eventTitle(assertion) { const subject=assertion.replace(/\b(?:ran|runs|offered|offers|launched|started|ended|was|were|is|are)\b[\s\S]*$/i,'').replace(/^that\s+/i,'').trim();const base=subject||'Business event';const suffix=/black friday/i.test(base)?'campaign':'event';return compact(/\b(?:campaign|promotion|launch|event)\b/i.test(base)?base:`${base} ${suffix}`).slice(0,140); }
function comparable(value) { return String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
export function isDuplicateProposal(wrapper, existing=[]) { if(!wrapper)return false;const candidate=comparable(wrapper.proposal.description||wrapper.proposal.definition||wrapper.proposal.statement);return existing.some(item=>{if(!['confirmed','working',undefined].includes(item.status))return false;const current=comparable(item.content||item.description||item.definition||item.statement);return candidate&&current&&(candidate===current||(candidate.length>24&&current.includes(candidate)));}); }
export function proposeFromMessage(message,{createdBy='oracle-ui',now=new Date(),existing=[]}={}) {
  if(typeof message!=='string')return null;const {assertion,explicit}=assertedText(message);if(!assertion||(!explicit&&!assertionVerb.test(assertion)))return null;
  const source_reference=`Oracle UI user assertion ${crypto.createHash('sha256').update(assertion).digest('hex').slice(0,12)} at ${now.toISOString()}`;const status=uncertain.test(assertion)?'working':'confirmed';const dates=isoDates(assertion);const common={status,source_type:'human_entered',source_reference,created_by:createdBy,supersedes:null,tags:[],effective_from:dates[0]||null,effective_to:dates[1]||dates[0]||null};let kind='fact',proposal;
  if(/\b(finding|investigation found)\b/i.test(assertion)){kind='memory';proposal=validateMemory({...common,status:'working',source_type:'human_entered',title:compact(assertion).slice(0,140),statement:assertion,memory_type:'hypothesis',evidence:[{kind:'user_attestation',reference:source_reference}]});}
  else if(/\bmeans|defined as\b/i.test(assertion)){kind='definition';const term=assertion.split(/\bmeans|defined as\b/i)[0].replace(/^that\s+/i,'').trim();proposal=validateKnowledgeItem(kind,{...common,term:term||'Business term',definition:assertion,implementation_reference:'Oracle UI human-entered definition'});}
  else if(dates.length||/\b(campaign|promotion|launched|started|ended|ran)\b/i.test(assertion)){kind='event';proposal=validateKnowledgeItem(kind,{...common,event_type:/campaign|promotion|offer/i.test(assertion)?'campaign':'business_event',title:eventTitle(assertion),description:assertion,date_precision:dates.length>1?'range':dates.length===1?'day':'unknown'});}
  else proposal=validateKnowledgeItem(kind,{...common,subject:compact(assertion.split(assertionVerb)[0])||'Business context',predicate:'states',statement:assertion});
  const wrapper={proposal_id:crypto.randomUUID(),kind,proposal,uncertain:proposal.status==='working',persisted:false,approval_required:true};
  if(isDuplicateProposal(wrapper,existing))return null;
  const sameTitle=existing.find(item=>comparable(item.title)===comparable(proposal.title||proposal.term||proposal.subject));
  if(sameTitle&&/^(?:kn|ev|df|mem)_[0-9a-f-]{16,}$/.test(sameTitle.id||''))proposal.supersedes=sameTitle.id;
  return wrapper;
}
export function proposalSearchText(wrapper){return wrapper?.proposal.description||wrapper?.proposal.definition||wrapper?.proposal.statement||'';}
export function validateApprovedProposal(kind,proposal){return kind==='memory'?validateMemory(proposal):validateKnowledgeItem(kind,proposal);}

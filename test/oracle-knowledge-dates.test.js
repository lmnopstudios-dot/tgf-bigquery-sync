import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveKnowledgeDates, campaignDateClarification } from '../oracle/knowledge-dates.js';
import { normalizeModelProposal } from '../oracle/proposals.js';
import { selectContext, validateKnowledgeItem } from '../oracle/knowledge.js';
import { toPhysicalRow } from '../knowledge/admin.js';

const timestamp='2026-09-30T12:00:00.000Z';

test('exact social brief resolves this week as London Monday through Sunday',()=>{
  const wording='This week on socials we are pushing the chunky crossbones ring and classic pieces.';
  assert.deepEqual(resolveKnowledgeDates(wording,{timestamp,timeZone:'Europe/London'}),{
    original_wording:'This week',effective_start:'2026-09-28',effective_end:'2026-10-04',precision:'range',time_zone:'Europe/London',message_timestamp:timestamp
  });
});

test('relative dates use the London calendar across UTC, week, month and year boundaries',()=>{
  assert.deepEqual(resolveKnowledgeDates('today',{timestamp:'2026-09-27T23:30:00Z'}),{original_wording:'today',effective_start:'2026-09-28',effective_end:'2026-09-28',precision:'day',time_zone:'Europe/London',message_timestamp:'2026-09-27T23:30:00.000Z'});
  assert.deepEqual(resolveKnowledgeDates('tomorrow',{timestamp:'2026-12-31T18:00:00Z'}).effective_start,'2027-01-01');
  assert.deepEqual(resolveKnowledgeDates('this week',{timestamp:'2026-10-04T12:00:00Z'}),{original_wording:'this week',effective_start:'2026-09-28',effective_end:'2026-10-04',precision:'range',time_zone:'Europe/London',message_timestamp:'2026-10-04T12:00:00.000Z'});
  assert.deepEqual(resolveKnowledgeDates('next week',{timestamp}).effective_start,'2026-10-05');
  assert.deepEqual(resolveKnowledgeDates('this month',{timestamp}).effective_end,'2026-09-30');
  assert.deepEqual(resolveKnowledgeDates('runs 28 September–4 October 2026',{timestamp}).effective_end,'2026-10-04');
  assert.deepEqual(resolveKnowledgeDates('runs 2026-09-28 to 2026-10-04',{timestamp}).effective_start,'2026-09-28');
});

test('resolved campaign dates survive delayed review and remain editable before approval',()=>{
  const resolution=resolveKnowledgeDates('This week we are pushing rings',{timestamp});
  const candidate={kind:'event',event_type:'marketing_campaign',title:'Social ring campaign',description:'A human-entered plan, not measured performance.',date_precision:resolution.precision,effective_from:resolution.effective_start,effective_to:resolution.effective_end,status:'confirmed',source_type:'human_entered',source_reference:'Original chat wording',tags:['marketing'],supersedes:null};
  const wrapper=normalizeModelProposal(candidate,{createdBy:'reviewer'});
  // Simulate a review and save weeks later: only recorded_at changes.
  wrapper.proposal.effective_from='2026-09-29';
  const row=toPhysicalRow('event',validateKnowledgeItem('event',wrapper.proposal),'2026-10-20T09:00:00.000Z');
  assert.equal(row.start_date,'2026-09-29');assert.equal(row.end_date,'2026-10-04');assert.equal(row.recorded_at,'2026-10-20T09:00:00.000Z');
});

test('expired campaigns are excluded from current context while timeless definitions remain',()=>{
  const expired={id:'ev_11111111-1111-4111-8111-111111111111',kind:'event',status:'confirmed',effective_from:'2026-09-28',effective_to:'2026-10-04',tags:['marketing']};
  const timeless={id:'df_11111111-1111-4111-8111-111111111111',kind:'definition',status:'confirmed',effective_from:null,effective_to:null,tags:[]};
  assert.deepEqual(selectContext([expired,timeless],{start_date:'2026-10-05',end_date:'2026-10-05'}).map(x=>x.id),[timeless.id]);
  const definition=validateKnowledgeItem('definition',{term:'Classic pieces',definition:'The permanent core collection.',implementation_reference:'Business glossary',status:'confirmed',source_type:'human_entered',source_reference:'Administrator',created_by:'reviewer',effective_from:null,effective_to:null,supersedes:null,tags:[]});
  assert.equal(definition.effective_from,null);assert.equal(definition.effective_to,null);
});

test('genuinely vague campaign timing gets one targeted question only',()=>{
  const question=campaignDateClarification('We will launch this campaign sometime later.',null);
  assert.equal(question,'What start and end dates should this campaign use?');
  assert.doesNotMatch(question,/sales|analysis|currency|GBP|USD/i);
});

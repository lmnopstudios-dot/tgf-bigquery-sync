import test from 'node:test';
import assert from 'node:assert/strict';
import {retentionLimitEvidence,retentionLimitSummary} from '../oracle/retention-limits.js';
test('independent main limits identify item truncation without implying missing collaborations, ranking or catalogue',()=>{
 const e={truncated:true,source_outcomes:[['retention_windows',54,99,false],['retention_piece_windows',99,99,true],['retention_baseline_windows',3,3,false]].map(([group,returned_rows,row_limit,truncated])=>({group,returned_rows,row_limit,truncated,state:'fulfilled',source_store:'combined'})),section_outcomes:[{component:'product_ranking_rows',state:'fulfilled',source_store:'combined'}],product_ranking_rows:Array.from({length:60},()=>({source_store:'combined'})),catalogue_reconciliation:Array(25).fill({})};
 const limits=retentionLimitEvidence(e);assert.equal(limits.filter(l=>l.status==='truncated').length,1);assert.match(retentionLimitSummary(e),/Individual collaboration items\/families \(99\/99/);assert.doesNotMatch(retentionLimitSummary(e),/additional collaborations/);assert.equal(limits.find(l=>l.section.startsWith('Whole-range')).status,'within_bound');assert.equal(limits.find(l=>l.section.startsWith('Governed')).returned,25);
 assert.match(retentionLimitSummary({truncated:true}),/legacy.*without identifying/i);
});

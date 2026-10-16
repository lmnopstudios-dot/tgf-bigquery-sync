import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acceptanceFixture, acceptanceServer, assertAcceptanceTurn, NOW } from './helpers/oracle-acceptance.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { naturalReportPeriod, reportPeriodResolution } from '../oracle/report-natural-period.js';
import { resolveAnalysisDecision, reportAnalysisDecision } from '../oracle/analysis-decision.js';
import { executeGovernedAgentAnalysis } from '../oracle/analysis-route-dispatcher.js';
const matrix=JSON.parse(readFileSync(new URL('./fixtures/oracle-acceptance-matrix.json',import.meta.url)));
for(const mode of ['direct','interactive','durable']){
  test(`acceptance matrix: real shared ${mode} execution and delivery`,async t=>{
    for(const conversation of matrix.conversations){
      await t.test(conversation.id,async t=>{
        const f=acceptanceFixture(conversation),h=await acceptanceServer(f,{durable:mode==='durable'});t.after(h.close);
        let prior=null;
        for(const turn of conversation.turns){
          const offset=f.calls.length;
          const context=transitionAnalysisContext(prior,turn.question,{now:NOW}).context;
          let result;
          if(mode==='direct'){
            const response=await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:turn.question,analysis_context:prior})});
            assert.equal(response.status,200);result=await response.json();
          }else result=await h.submit(turn.question);
          assert.ok(result.analysis_context,'Resolved context must survive delivery');
          assertAcceptanceTurn(turn,result,f,offset);
          if(mode==='durable'){
            // Serialized stored result, owned polling, no repeated provider calls.
            const count=f.calls.length,job=h.jobs.jobs.get(result.job_id);
            assert.ok(job.result_json.answer?.trim());
            const recovered=await h.get('/jobs/'+result.job_id);
            assert.equal(recovered.answer,result.answer);assert.deepEqual(recovered.evidence,result.evidence);assert.equal(f.calls.length,count);
            if(result.evidence){const latest=await h.get('/analysis/latest');assert.ok(latest.analysis?.answer?.trim());}
          }
          prior=result.analysis_context;
        }
      });
    }
  });
}

test('calendar matrix is shared across subjects and preserves reporting semantics',()=>{
  const periods=[
    ['last 30 completed days','2026-09-14','2026-10-13',false],['past 30 days','2026-09-15','2026-10-14',true],
    ['last week','2026-10-05','2026-10-11',false],['past seven days','2026-10-08','2026-10-14',true],
    ['this month','2026-10-01','2026-10-14',true],['last month','2026-09-01','2026-09-30',false],
    ['last 4 completed months','2026-06-01','2026-09-30',false],['last three completed months','2026-07-01','2026-09-30',false],
    ['last 3 years','2023-10-14','2026-10-14',true],['past three years','2023-10-14','2026-10-14',true],['last two completed years','2024-01-01','2025-12-31',false],
    ['this year','2026-01-01','2026-10-14',true],['last year','2025-01-01','2025-12-31',false]
  ];
  for(const [phrase,start,end,included] of periods){
    const p=naturalReportPeriod(phrase,NOW);assert.deepEqual([p.start_date,p.end_date,p.current_day_included],[start,end,included]);
    for(const subject of ['Show online sales','Show Shopify customers','Show shipping countries','Show mobile and desktop conversion rates','Show Klaviyo campaigns']){
      const c=transitionAnalysisContext(null,`${subject} for ${phrase}`,{now:NOW}).context;
      assert.deepEqual([c.start_date,c.end_date],[start,end],`${subject}: ${phrase}`);assert.equal(resolveAnalysisDecision(c).outcome,'execution');
    }
  }
  const matched=naturalReportPeriod('this year versus last year for matching elapsed periods',NOW);
  assert.deepEqual([matched.comparison_start_date,matched.comparison_end_date],['2025-01-01','2025-10-14']);
  assert.equal(naturalReportPeriod('past 1 day',Date.parse('2026-10-13T23:30:00Z')).start_date,'2026-10-14');
});

test('invalid calendar input never executes retained dates; a valid reply advances',async()=>{
  const f=acceptanceFixture(),prior=transitionAnalysisContext(null,'Show online sales last month',{now:NOW}).context;
  for(const invalid of ['last 0 completed days','last 99999 days','2026-02-30 to 2026-03-02','2026-10-10 to 2026-09-01']){
    assert.equal(reportPeriodResolution(invalid,NOW).invalid,true);
    const c=transitionAnalysisContext(prior,invalid,{now:NOW}).context;
    const decision=resolveAnalysisDecision(c);assert.equal(decision.outcome,'clarification');assert.deepEqual(decision.fields,['start_date','end_date']);
    const result=await executeGovernedAgentAnalysis({message:invalid,analysisContext:c,scopeResolved:true,baselineOverview:f.baseline,now:NOW});
    assert.match(result.answer,/invalid/);assert.equal(f.calls.length,0);
    const repaired=transitionAnalysisContext(c,'Last 30 completed days',{now:NOW}).context;
    assert.equal(resolveAnalysisDecision(repaired).outcome,'execution');assert.equal(repaired.period_issue,null);
    assert.deepEqual([repaired.start_date,repaired.end_date],['2026-09-14','2026-10-13']);
  }
});

test('decision diagnostics expose structure without prompts or exceptions',()=>{
  for(const question of ['Show online sales','Show online sales last month','Show abandoned checkouts last month']){
    const c=transitionAnalysisContext(null,question,{now:NOW}).context,logs=[];
    reportAnalysisDecision(resolveAnalysisDecision(c),event=>logs.push(event));
    assert.equal(logs.filter(e=>e.stage==='analysis_decision').length,1);assert.doesNotMatch(JSON.stringify(logs),/Show |private|@|Error/);
    assert.ok(['execution','clarification','limitation'].includes(logs.find(e=>e.stage==='analysis_decision').status));
  }
});

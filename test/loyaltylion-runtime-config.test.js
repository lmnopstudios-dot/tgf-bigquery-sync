import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadLoyaltyConfig} from '../loyaltylion/runtime-config.js';
import {reviewedConfig} from './helpers/loyalty-fixture.js';
import {spawnSync} from 'node:child_process';
test('private config overrides stub; missing or invalid private files never fall back',()=>{
 assert.equal(loadLoyaltyConfig({}).access_status,'unverified');
 const dir=mkdtempSync(join(tmpdir(),'loyalty-config-'));
 try{
  const file=join(dir,'config.json'),c=reviewedConfig();
  writeFileSync(file,JSON.stringify(c),{mode:0o600});
  assert.equal(loadLoyaltyConfig({LOYALTYLION_CONFIG_PATH:file}).program_id,c.program_id);
  writeFileSync(file,'not json');
  assert.throws(()=>loadLoyaltyConfig({LOYALTYLION_CONFIG_PATH:file}),{code:'LOYALTY_RUNTIME_CONFIG_INVALID'});
  assert.throws(()=>loadLoyaltyConfig({LOYALTYLION_CONFIG_PATH:join(dir,'missing')}),{code:'LOYALTY_RUNTIME_CONFIG_INVALID'});
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('production default provider and parser share private program identity through fresh and continued chat',()=>{
 const dir=mkdtempSync(join(tmpdir(),'loyalty-report-config-'));
 try{
  const file=join(dir,'config.json');
  writeFileSync(file,JSON.stringify(reviewedConfig()),{mode:0o600});
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
   import assert from 'node:assert/strict';
   import {loyaltyFixture} from './test/helpers/loyalty-fixture.js';
   import {createLoyaltyReportService} from './oracle/loyaltylion.js';
   import {createBaselineOverviewService} from './oracle/baseline-overview.js';
   import {createOracleBaselineDispatcher} from './oracle/baseline-dispatcher.js';
   import {acceptanceServer} from './test/helpers/oracle-acceptance.js';
   const message='Show a LoyaltyLion overview from 2026-11-01 through 2026-11-05 inclusive. Include current membership and tiers, points movements, reward claims and Shopify order linkage. Show matched, unmatched/ineligible and missing-order-reference counts. State the membership snapshot collection time separately from report generation time.';
   for(const durable of [false,true]){
    const f=loyaltyFixture(),original=f.bigquery.query;
    f.bigquery.query=async q=>{
     const [rows]=await original(q);
     return [rows.map(row=>({...row,...(row.date?{date:row.date.replace('2026-10','2026-11')}:{}) ,...(row.resource&&row.run_id?{start_at:'2026-11-01T00:00:00Z',end_exclusive:'2026-11-06T00:00:00Z'}:{})}))];
    };
    const provider=createLoyaltyReportService({bigquery:f.bigquery,project:'fixture',env:{LOYALTYLION_REPORTING_ENABLED:'true'}});
    f.baseline=createOracleBaselineDispatcher({ecommerceBaselineOverview:createBaselineOverviewService({loyalty:provider})});
    const h=await acceptanceServer(f,{durable,now:Date.parse('2026-11-13T12:00:00Z')});
    try{
     for(const fresh of [true,false]){
      const result=await h.submit(message,{fresh});
      assert.equal(result.evidence.program_id,'1');
      assert.equal(result.analysis_context.loyalty_scope.program_id,'1');
      assert.equal(result.analysis_context.start_date,'2026-11-01');
      assert.equal(result.analysis_context.end_date,'2026-11-05');
      assert.equal(result.evidence.sections.length,5);
      assert.equal(result.evidence.sections.find(s=>s.section==='membership').status,'fulfilled');
      assert.equal(result.evidence.sections.find(s=>s.section==='points').status,'fulfilled');
      assert.equal(result.evidence.sections.find(s=>s.section==='linkage').linkage_coverage.matched,2);
      const performance=await h.submit('LoyaltyLion performance report for October 2026');
      assert.equal(performance.evidence.program_id,'1');
      assert.equal(performance.evidence.performance.version,1);
      assert(performance.artifact);

     }
    }finally{await h.close();}
   }
  `],{cwd:new URL('..',import.meta.url),env:{...process.env,LOYALTYLION_CONFIG_PATH:file},encoding:'utf8',timeout:45000,maxBuffer:2_000_000});
  assert.equal(child.status,0,child.stderr+'\n'+child.stdout);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

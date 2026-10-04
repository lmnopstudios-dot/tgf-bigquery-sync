import test from 'node:test';
import assert from 'node:assert/strict';
import {main} from '../diagnostics/black-friday-event-scope.js';

test('diagnostic reuses established project and service-account credential helper',async()=>{
  let options,query;class FakeBigQuery{constructor(value){options=value;}async query(value){query=value;return[[]];}}
  let output='';const resolved=await main({env:{GOOGLE_PROJECT_ID:'warehouse',GOOGLE_SERVICE_ACCOUNT_JSON:JSON.stringify({project_id:'credential-project',client_email:'svc@example.com'})},argv:['--as-of=2026-10-04'],BigQueryClass:FakeBigQuery,write:value=>{output+=value;}});
  assert.equal(options.projectId,'warehouse');assert.equal(options.credentials.client_email,'svc@example.com');assert.match(query.query,/oracle_knowledge\.events/);assert.deepEqual(resolved.missing.map(x=>x.year),[2024,2023]);assert.deepEqual(resolved.unmatched.map(x=>x.phase),['vip_early_access','public']);assert.match(output,/"unconfirmed"/);
});

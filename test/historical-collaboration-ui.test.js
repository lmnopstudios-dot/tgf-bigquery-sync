import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createOracleUiRouter} from '../oracle/ui-router.js';
import {historicalFixture} from './helpers/historical-collaboration-fixture.js';
import {historicalCollaborationRequest} from '../public/oracle/historical-collaboration.js';

test('historical collaboration endpoints require authentication/CSRF and save direct Woo evidence through the real service',async t=>{
 const f=historicalFixture(),env={ORACLE_UI_PASSWORD:'fixture',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012',ORACLE_UI_ADMIN_NAME:'reviewer'};
 f.mapping.state.outcomes.push({source_ref:'woo:ww:100',outcome:'no_equivalent',reviewed_at:'2026-10-01'});
 const app=express();app.use('/api/oracle',createOracleUiRouter({env,project:'fixture',bigquery:f.bigquery,historicalCollaborationService:f.service,chat:async()=>({answer:'unused'}),generateProposals:async()=>[]}));
 const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s));});t.after(()=>{server.closeAllConnections();server.close();});const origin='http://127.0.0.1:'+server.address().port,base=origin+'/api/oracle';
 assert.equal((await fetch(base+'/historical-collaborations')).status,401);
 const auth=await fetch(base+'/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password:'fixture'})}),session=await auth.json(),cookie=auth.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
 const response=await fetch(base+'/historical-collaborations?source=woo:ww&inventory=no_equivalent',{headers:{cookie}});assert.equal(response.status,200);const data=await response.json();assert.equal(data.items.length,1);assert.equal(data.items[0].mapping_status,'no_equivalent');
 const input=historicalCollaborationRequest(data.items,data.collaborations[0]),headers={cookie,origin,'content-type':'application/json','x-csrf-token':session.csrf};
 assert.equal((await fetch(base+'/historical-collaborations',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify(input)})).status,403);assert.equal(f.state.rows.length,0);
 const saved=await fetch(base+'/historical-collaborations',{method:'POST',headers,body:JSON.stringify(input)});assert.equal(saved.status,200);assert.equal((await saved.json()).status,'complete');assert.equal(f.state.rows.length,2);
 const status=await fetch(base+'/historical-collaborations/operations/'+input.operation_id,{headers:{cookie}});assert.equal((await status.json()).results[0].status,'saved');
 const invalid=await fetch(base+'/historical-collaborations',{method:'POST',headers,body:JSON.stringify({...input,source_refs:['square:square:100']})});assert.equal(invalid.status,400);assert.equal(f.state.rows.length,2);assert.equal(f.mapping.state.families.length,0);assert.equal(f.mapping.state.outcomes.length,1);
});

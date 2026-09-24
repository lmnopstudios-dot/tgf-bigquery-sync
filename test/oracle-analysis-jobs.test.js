import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { createMemoryAnalysisJobStore } from '../oracle/analysis-jobs.js';

const env={ORACLE_UI_PASSWORD:'test-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012',ORACLE_JOB_RUNTIME_MS:'120000'};
const DANIELLE_FULL_EMAIL=`Danielle has asked us to look at clearing the following stock online:
Small Signet; Butterfly, Ankh, Eagle and Pig charms; Sun and Moon, Serpent, Dagger, Snake and Dagger, Magic Mushroom and Enchanted Castle pendants; Reaper and Pentagram; gold and silver bat earrings; Solid Heart and Smallest Evil Skull rings; and all three skull-hoop variations.
Any ideas of what we can do? Use data where possible.`;
const ITEMS=['Small Signet','Butterfly','Ankh','Eagle','Pig','Sun and Moon','Serpent','Dagger','Snake and Dagger','Magic Mushroom','Enchanted Castle','Reaper','Pentagram','gold bat earrings','silver bat earrings','Solid Heart','Smallest Evil Skull','skull-hoop 1','skull-hoop 2','skull-hoop 3'];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function login(base){const response=await fetch(`${base}/auth/login`,{method:'POST',headers:{origin:new URL(base).origin,'content-type':'application/json'},body:'{"password":"test-password"}'}),data=await response.json();return {cookie:response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),csrf:data.csrf};}
const poll=async(base,id,cookie)=>{for(let i=0;i<10_000;i++){const body=await (await fetch(`${base}/jobs/${id}`,{headers:{cookie}})).json();if(['completed','failed','cancelled'].includes(body.status))return body;await sleep(10)}throw new Error('job did not finish')};

test('durable Danielle job survives request disconnect/refresh, is private, and returns one complete synthesis',async t=>{
  const store=createMemoryAnalysisJobStore();let executions=0;
  const chat=async(message,{durable,signal})=>{executions++;assert.equal(message,DANIELLE_FULL_EMAIL);assert.equal(durable,true);await sleep(75_100);assert.equal(signal.aborted,false);return {answer:`Complete answer\n${ITEMS.join('\n')}`,tools:['catalogue','inventory','sales']}};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'p',chat,generateProposals:async()=>[],analysisJobStore:store,env}));
  const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s))});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin,auth=await login(base),headers={cookie:auth.cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf};
  const submitted=await (await fetch(`${base}/jobs`,{method:'POST',headers,body:JSON.stringify({message:DANIELLE_FULL_EMAIL})})).json();assert.ok(submitted.job_id); // the browser may now disconnect or refresh
  const stranger=await login(base);assert.equal((await fetch(`${base}/jobs/${submitted.job_id}`,{headers:{cookie:stranger.cookie}})).status,404);
  const result=await poll(base,submitted.job_id,auth.cookie);assert.equal(result.status,'completed');for(const item of ITEMS)assert.match(result.answer,new RegExp(item,'i'));assert.equal(executions,1);
  const refreshed=await poll(base,submitted.job_id,auth.cookie);assert.equal(refreshed.answer,result.answer);assert.equal(executions,1);
});

test('Cancel aborts running work and stale leases are safely failed rather than duplicated',async t=>{
  const stale=createMemoryAnalysisJobStore([{job_id:'stale',owner_key:'o',request_id:'r',status:'running',payload_json:{},attempts:1,cancel_requested:false,lease_until:new Date(Date.now()-1).toISOString()}]);await stale.claim({leaseMs:100});assert.equal(stale.jobs.get('stale').status,'failed');assert.equal(stale.jobs.get('stale').error_code,'WORKER_RESTARTED');
  const store=createMemoryAnalysisJobStore();let aborted=false;const chat=async(_m,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason)},{once:true}));
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'p',chat,generateProposals:async()=>[],analysisJobStore:store,env}));const server=await new Promise(resolve=>{const s=app.listen(0,()=>resolve(s))});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin,auth=await login(base),headers={cookie:auth.cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf};const job=await (await fetch(`${base}/jobs`,{method:'POST',headers,body:'{"message":"cancel this analysis"}'})).json();for(let i=0;i<150&&store.jobs.get(job.job_id).status!=='running';i++)await sleep(10);await fetch(`${base}/jobs/${job.job_id}/cancel`,{method:'POST',headers,body:'{}'});const result=await poll(base,job.job_id,auth.cookie);assert.equal(result.status,'cancelled');for(let i=0;i<150&&!aborted;i++)await sleep(10);assert.equal(aborted,true);
});

test('durable transport budget exceeds the former 74-second synthesis edge',async()=>{const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../server.js',import.meta.url),'utf8'));assert.match(source,/durable\?7\*60_000\+5_000:74_000/);assert.match(source,/durable_job:durable/);});

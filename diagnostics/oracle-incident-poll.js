#!/usr/bin/env node
// GET only, using the incident owner's existing browser session. Never print it.
import { oracleResultContent } from '../public/oracle/result-contract.js';
const safe=x=>/^[A-Za-z0-9_.-]{1,80}$/.test(String(x||''))?String(x):null;
const jobId=process.argv[2],origin=process.env.ORACLE_UI_ORIGIN,cookie=process.env.ORACLE_INCIDENT_SESSION_COOKIE;
try{
 if(!safe(jobId)||!origin||!cookie)throw Error('configuration');
 const url=new URL(`/api/oracle/jobs/${encodeURIComponent(jobId)}`,origin);
 if(!['https:','http:'].includes(url.protocol))throw Error('configuration');
 const response=await fetch(url,{headers:{cookie},signal:AbortSignal.timeout(15_000),redirect:'error'});
 const result=await response.json(),content=oracleResultContent(result);
 console.log(JSON.stringify({read_only:true,job_id:jobId,http_status:response.status,status:safe(result.status),code:safe(result.code),answer_present:content.deliverable,answer_characters:typeof result.answer==='string'?result.answer.trim().length:0,evidence_present:Boolean(result.evidence),artifact_present:content.artifactValid,delivery_version:safe(result.delivery?.version),recovered_persisted_result:result.recovered_persisted_result===true,browser_delivery_verified:false}));
 if(!response.ok)process.exitCode=1;
}catch{console.log(JSON.stringify({read_only:true,job_id:safe(jobId),status:'unverified',stage:'authenticated_poll',code:origin&&cookie?'POLL_UNAVAILABLE':'OWNER_SESSION_CONFIGURATION_REQUIRED'}));process.exitCode=1;}

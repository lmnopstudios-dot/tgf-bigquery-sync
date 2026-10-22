#!/usr/bin/env node
// Metadata only: never retrieves query results, SQL text, or raw provider messages.
import {BigQuery} from '@google-cloud/bigquery';
import {pathToFileURL} from 'node:url';
import {loadOracleJobReadinessConfig} from './oracle-job-readiness.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';
import {safeReadFailure} from '../oracle/read-failure.js';

export async function inspectRetentionIncidentJobs(bigquery,jobs){
  if(!jobs||Object.keys(jobs).length!==3||!['ww','usd','shopify'].every(s=>/^[A-Za-z0-9_-]{1,100}$/.test(jobs[s]||'')))throw Object.assign(Error('Invalid job arguments'),{code:'COHORT_ARGUMENT_REJECTED'});
  return Promise.all(Object.entries(jobs).map(async([source,job_id])=>{
    try{
      const [m]=await boundedEvidenceRead(()=>bigquery.job(job_id,{location:'US'}).getMetadata({maxRetries:0}),{maximumMs:8000});
      const error=m.status?.errorResult;
      return {source,job_id,location:'US',state:['PENDING','RUNNING','DONE'].includes(m.status?.state)?m.status.state:null,
        failure:error?safeReadFailure({errors:[error,...(m.status?.errors||[])]},'diagnostic'):null};
    }catch(error){return {source,job_id,location:'US',metadata_available:false,failure:safeReadFailure(error,'diagnostic')};}
  }));
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  try{
    const ids=process.argv.slice(2);
    if(ids.length!==3)throw Object.assign(Error('Expected three job IDs'),{code:'COHORT_ARGUMENT_REJECTED'});
    const jobs=Object.fromEntries(['ww','usd','shopify'].map((source,i)=>[source,ids[i]]));
    const c=loadOracleJobReadinessConfig();
    const bq=new BigQuery({projectId:c.project,credentials:c.credentials,autoRetry:false,maxRetries:0});
    console.log(JSON.stringify({providers:await inspectRetentionIncidentJobs(bq,jobs)}));
  }catch(error){console.error(JSON.stringify(safeReadFailure(error,'diagnostic')));process.exitCode=1;}
}

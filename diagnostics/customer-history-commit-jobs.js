// Incident-specific jobs.get only: no SQL, results, cancellation or collection.
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';
import {inspectBigQueryJob} from './oracle-bigquery-job.js';

export const JOB_IDS=Object.freeze([
  'history_d4471e2ac16642f8b9ceef6f4df15aa8',
  'history_d04a714331ef40508b54f8ccf68b817c',
]);
export async function inspectCommitJobs(bigquery) {
  const deadlineAt=Date.now()+20000;
  const read=work=>boundedEvidenceRead(work,{maximumMs:5000,deadlineAt});
  const results=[];
  // Resolve the actual dataset location; never guess US/EU.
  const [dataset]=await read(()=>bigquery.dataset('customer_identity').getMetadata({maxRetries:0}));
  if(!/^[A-Za-z0-9-]{1,100}$/.test(dataset.location||''))throw Error('Dataset location unavailable');
  for(const jobId of JOB_IDS) {
    try {
      const [metadata]=await read(()=>bigquery.job(jobId,{location:dataset.location}).getMetadata({maxRetries:0}));
      const evidence=await inspectBigQueryJob({bigquery:{job:()=>({getMetadata:async()=>[metadata]})},jobId,location:dataset.location});
      results.push({...evidence,
        // Preserve terminal errors exactly, rather than passing them through the
        // history reason allowlist. Treat this operator output as private.
        provider_status:metadata.status??null,
        script_statistics:metadata.statistics?.scriptStatistics??null,
        num_child_jobs:metadata.statistics?.numChildJobs??null,
        transaction_info:metadata.statistics?.transactionInfo??null,
        execution_performance_insights:metadata.statistics?.query?.performanceInsights??null,
        resource_warning:metadata.statistics?.query?.resourceWarning??null,
      });
    } catch(error) {
      results.push({job_id:jobId,inspection:'unverified',code:error.code??'METADATA_READ_FAILED'});
    }
  }
  return {read_only:true,location:dataset.location,jobs:results,
    limitations:'Two exact parent jobs only; no child listing. Missing statistics are unknown, not zero. No SQL, query parameters or result rows emitted. Provider errors may contain private text; retain output privately.'};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href) {
  inspectCommitJobs(createBigQueryClient().bigquery).then(result=>{
    console.log(JSON.stringify(result,null,2));
    if(result.jobs.some(j=>j.inspection==='unverified'))process.exitCode=2;
  }).catch(error=>{
    console.log(JSON.stringify({read_only:true,inspection:'unverified',code:error.code??'METADATA_READ_FAILED'}));
    process.exitCode=2;
  });
}

import {validateAnalysisContext} from './analysis-context.js';
import {executionRevision} from './analysis-jobs.js';
import {boundedEvidenceRead} from './bounded-evidence-read.js';

const reject=code=>{throw Object.assign(Error('Recovery precondition rejected'),{code});};
const identifier=value=>/^[A-Za-z0-9_-]+$/.test(value||'')?value:reject('RECOVERY_CONFIGURATION_INVALID');
const uuid=value=>/^[a-f0-9-]{36}$/i.test(value||'')?value:reject('RECOVERY_IDENTIFIERS_INVALID');
const parse=value=>typeof value==='string'?JSON.parse(value):value;
export function assertRecoverableContextJob(row,revision){
 if(!executionRevision(revision))reject('RECOVERY_REVISION_REQUIRED');
 if(row.status!=='failed'||row.error_code!=='INVALID_ANALYSIS_CONTEXT'||row.cancel_requested!==false||row.lease_until!=null||!row.owner_key||!Number.isInteger(Number(row.attempts))||Number(row.attempts)<1)reject('RECOVERY_STATE_REJECTED');
 const payload=parse(row.payload_json),lifecycle=parse(row.lifecycle_json),result=parse(row.result_json);
 if(!executionRevision(lifecycle?.execution_revision)||lifecycle.execution_revision===revision||lifecycle.recovery)reject('RECOVERY_PROVENANCE_REJECTED');
 if(!result||result.failed_stage!=='analysis'||result.code!=='INVALID_ANALYSIS_CONTEXT'||Object.keys(result).some(k=>!['failed_stage','code','validation_field','validation_rule'].includes(k)))reject('RECOVERY_SAVED_RESULT_REJECTED');
 if(!payload?.analysis_context||typeof payload.message!=='string')reject('RECOVERY_PAYLOAD_REJECTED');
 validateAnalysisContext(payload.analysis_context);
 if(payload.previous_analysis_context!=null)validateAnalysisContext(payload.previous_analysis_context);
 return {execution_revision:lifecycle.execution_revision,attempts:Number(row.attempts)};
}

// Default is SELECT-only. Explicit execution is a single fenced transaction,
// never an enqueue, provider call, worker claim or automatic retry.
export async function recoverContextJob({bigquery,project,dataset,table,requestId,jobId,revision,execute=false,fingerprint=null,legacyWorkersRetired=false}){
 const target=[project,dataset,table].map(identifier).join('.');uuid(requestId);uuid(jobId);
 if(!executionRevision(revision))reject('RECOVERY_REVISION_REQUIRED');
 const [metadata]=await boundedEvidenceRead(()=>bigquery.dataset(dataset).getMetadata({maxRetries:0}),{maximumMs:5000});
 const location=identifier(metadata.location),options={location,useLegacySql:false,maximumBytesBilled:'100000000',jobTimeoutMs:15000,labels:{component:'oracle_recovery'}};
 const [rows]=await boundedEvidenceRead(()=>bigquery.query({...options,query:`SELECT TO_JSON_STRING(jobs) AS row_internal,TO_HEX(SHA256(CONCAT(@revision,TO_JSON_STRING(jobs)))) AS fingerprint FROM \`${target}\` AS jobs WHERE request_id=@request_id AND job_id=@job_id LIMIT 2`,params:{request_id:requestId,job_id:jobId,revision}}),{maximumMs:18000});
 if(rows.length!==1)reject('RECOVERY_ROW_COUNT_REJECTED');
 const row=parse(rows[0].row_internal),state=assertRecoverableContextJob(row,revision);
 const expected=rows[0].fingerprint;
 if(!/^[A-F0-9]{64}$/.test(expected||''))reject('RECOVERY_FINGERPRINT_INVALID');
 const plan={read_only:!execute,revision,status:'eligible',job_state:row.status,attempts:state.attempts,failed_execution_revision:state.execution_revision,required_execution_revision:revision,actual_location:location,fingerprint:expected,legacy_workers_must_be_retired:true};
 if(!execute)return plan;
 if(!legacyWorkersRetired)reject('RECOVERY_LEGACY_WORKERS_NOT_RETIRED');
 if(fingerprint!==expected)reject('RECOVERY_FINGERPRINT_MISMATCH');
 const audit={version:1,required_execution_revision:revision,prepared_fingerprint:expected,previous_status:row.status,previous_error_code:row.error_code,previous_attempts:row.attempts,previous_result:parse(row.result_json),previous_lifecycle:parse(row.lifecycle_json)};
 // Fence the entire original row (including owner, payload, lease and failure),
 // assert singleton inside the transaction, and leave immutable identity intact.
 const params={request_id:requestId,job_id:jobId,revision,fingerprint:expected,audit:JSON.stringify(audit)};
 const query=`BEGIN TRANSACTION;
 ASSERT (SELECT COUNT(*) FROM \`${target}\` AS jobs WHERE request_id=@request_id AND job_id=@job_id)=1 AS 'RECOVERY_ROW_COUNT_REJECTED';
 UPDATE \`${target}\` AS jobs SET status='queued',error_code=NULL,result_json=NULL,claim_token=NULL,worker_id=NULL,lease_until=NULL,updated_at=CURRENT_TIMESTAMP(),lifecycle_json=JSON_OBJECT('stage','explicit_recovery','recovery',JSON_SET(PARSE_JSON(@audit),'$.requeued_at',TO_JSON(CURRENT_TIMESTAMP())))
 WHERE request_id=@request_id AND job_id=@job_id AND status='failed' AND error_code='INVALID_ANALYSIS_CONTEXT' AND cancel_requested=FALSE AND lease_until IS NULL AND TO_HEX(SHA256(CONCAT(@revision,TO_JSON_STRING(jobs))))=@fingerprint;
 ASSERT @@row_count=1 AS 'RECOVERY_FENCE_REJECTED';
 COMMIT TRANSACTION;`;
 await boundedEvidenceRead(async()=>{const [job]=await bigquery.createQueryJob({...options,query,params});await job.getQueryResults();},{maximumMs:18000});
 return {...plan,status:'requeued',fingerprint:undefined};
}

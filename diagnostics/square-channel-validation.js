import {BigQuery} from '@google-cloud/bigquery';
import {createHash,randomUUID} from 'node:crypto';
import {openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {loadBigQueryConfig} from '../bigquery/client.js';
import {squarePreviewPlan} from '../customer-identity/square-preview.js';
import {squarePaymentChannelEvidenceSql,squareOrderChannelsSql} from '../oracle/square-channels.js';
import {safeSqlFailure} from './square-safe-sql-error.js';

export const CHANNEL_LIMITS=Object.freeze({bytes:'1000000000',queryMs:45000,wallMs:90000});
const safeCode=(field,values)=>`CASE WHEN ${field} IS NULL THEN 'MISSING' WHEN ${field} IN (${values.map(v=>`'${v}'`).join(',')}) THEN ${field} ELSE 'OTHER' END`;
export function squareChannelValidationSql(project){
 const latest=squarePreviewPlan(project,{dataset:'customer_identity',snapshot:'history-20261022-billing-v3',mode:'email_candidate_v2',orderLinks:true}).stages.find(s=>s.name==='sp_square_latest').select;
 const flags=['payment_rows','completed_payments','card_present_payments','ignored_noncompleted_payments','missing_payment_location','conflicting_payment_location','conflicting_entry_method','missing_payment_type','noncard_completed_payments','missing_entry_method','nonpresent_completed_payments'];
 const methods=['EMV','SWIPED','CONTACTLESS','KEYED','ON_FILE'];
 return `WITH latest_orders AS(${latest}),
 sx_square AS(SELECT * FROM latest_orders WHERE state IN ('COMPLETE','COMPLETED') AND DATE(ts,'Europe/London')<=DATE '2026-10-19'),
 sx_channel_evidence AS(${squarePaymentChannelEvidenceSql(project)}),
 sx_square_channels AS(${squareOrderChannelsSql()}),
 shapes AS(SELECT ${safeCode('p.flat_entry_method',methods)} flat_method,${safeCode('p.nested_entry_method',methods)} nested_method,
 ${safeCode('p.status',['COMPLETED','PENDING','APPROVED','FAILED','CANCELED'])} payment_status,
 ${safeCode('p.source_type',['CARD','CASH','EXTERNAL','WALLET','BANK_ACCOUNT','BUY_NOW_PAY_LATER'])} payment_type,COUNT(*) payment_rows
 FROM sx_channel_evidence p JOIN sx_square o USING(oid) GROUP BY flat_method,nested_method,payment_status,payment_type)
 SELECT (SELECT COUNT(*) FROM sx_square) eligible_orders,
 ARRAY(SELECT AS STRUCT channel,channel_reason,COUNT(*) orders,${flags.map(f=>`SUM(${f}) ${f}`).join(',')}
 FROM sx_square_channels GROUP BY channel,channel_reason ORDER BY channel,channel_reason) outcomes,
 ARRAY(SELECT AS STRUCT * FROM shapes ORDER BY payment_status,payment_type,flat_method,nested_method) payment_shapes`;
}
export function validateChannelAggregate(rows){
 if(rows.length!==1)throw Error('Channel aggregate incomplete');const r=rows[0],valid=n=>n!=null&&n!==''&&typeof n!=='boolean'&&Number.isSafeInteger(Number(n))&&Number(n)>=0;
 if(!valid(r.eligible_orders)||Number(r.eligible_orders)===0||!Array.isArray(r.outcomes)||!r.outcomes.length||!Array.isArray(r.payment_shapes))throw Error('Channel population unavailable');
 if(r.outcomes.reduce((n,o)=>n+Number(o.orders),0)!==Number(r.eligible_orders))throw Error('Channel population does not reconcile');
 for(const o of r.outcomes){if(!['In-store','Unknown'].includes(o.channel)||!/^[a-z_]+$/.test(o.channel_reason))throw Error('Invalid classification');for(const [k,v]of Object.entries(o))if(!['channel','channel_reason'].includes(k)&&!valid(v))throw Error('Invalid count');if(o.channel==='In-store'&&(o.channel_reason!=='completed_card_present_at_order_location'||Number(o.completed_payments)!==Number(o.card_present_payments)||Number(o.completed_payments)===0||['missing_payment_location','conflicting_payment_location','conflicting_entry_method','missing_payment_type','noncard_completed_payments','missing_entry_method','nonpresent_completed_payments'].some(k=>Number(o[k])!==0)))throw Error('Unsupported in-store classification');}
 for(const p of r.payment_shapes)if(!valid(p.payment_rows))throw Error('Invalid payment shape count');
 const visit=x=>{if(x&&typeof x==='object')for(const [k,v]of Object.entries(x)){if(/^(?:oid|order_id|order_ref|location_id|customer_id|email|email_address)$/.test(k))throw Error('Aggregate-only output required');visit(v);}};visit(r);
}
export async function validateSquareChannels({bigquery,project,location,emit}){
 const query=squareChannelValidationSql(project),jobId='square_channel_validate_'+randomUUID().replaceAll('-','');let job;
 emit({stage:'channel_manifest',read_only:true,cutoff:'2026-10-19',time_zone:'Europe/London',maximum_bytes_billed:CHANNEL_LIMITS.bytes,query_sha256:createHash('sha256').update(query).digest('hex'),report_replayed:false,activation:false,identity_changed:false});
 try{
  const [dry]=await bigquery.createQueryJob({query,location,dryRun:true,useLegacySql:false,maximumBytesBilled:CHANNEL_LIMITS.bytes});
  const bytes=dry.metadata?.statistics?.totalBytesProcessed??dry.metadata?.statistics?.query?.totalBytesProcessed;
  if(!/^\d+$/.test(String(bytes??''))||BigInt(bytes)>BigInt(CHANNEL_LIMITS.bytes))throw Error('Dry-run estimate unavailable or exceeds ceiling');emit({stage:'channel_dry_run',status:'validated',estimated_bytes:String(bytes)});
  [job]=await bigquery.createQueryJob({query,location,jobId,useLegacySql:false,maximumBytesBilled:CHANNEL_LIMITS.bytes,jobTimeoutMs:CHANNEL_LIMITS.queryMs,labels:{component:'square_channel_validation',operation:'aggregate_read'}});
  emit({stage:'channel_allocated',job_id:jobId});
  const [rows,next,response]=await job.getQueryResults({autoPaginate:false,maxResults:2}),[m]=await job.getMetadata();
  if(m.status?.errorResult)throw m.status.errorResult;
  if(m.status?.state!=='DONE'||next||response?.jobComplete===false||response?.totalRows!=null&&String(response.totalRows)!==String(rows.length))throw Error('Channel result retrieval incomplete');
  validateChannelAggregate(rows);emit({stage:'channel_results',status:'validated',job_id:jobId,rows,billed_bytes:m.statistics?.query?.totalBytesBilled??null,limitations:['Payment counters are persisted rows, not deduplicated payment IDs.','Primary reasons partition orders; individual evidence flags can overlap.','No customer identity, mapping, retention or second-purchase report was recalculated.','This validates channel evidence only; it does not certify historical completeness or activate Square.']});return true;
 }catch(e){if(job?.cancel)try{const [m]=await job.getMetadata();if(m.status?.state!=='DONE'){await job.cancel();emit({stage:'channel_cancellation',status:'requested',job_id:job.id||jobId});}}catch{}emit({stage:'channel_validation',status:'unavailable',job_id:job?.id||null,...safeSqlFailure(e,query)});return false;}
}
export async function main(){
 const path=`/tmp/square-channel-validation-${Date.now()}.jsonl`,fd=openSync(path,'wx',0o600),emit=x=>{const s=JSON.stringify(x);writeSync(fd,s+'\n');fsyncSync(fd);console.log(s);};
 console.log(JSON.stringify({stage:'output_file',path,activation:false,production_writes:false}));
 const timer=setTimeout(()=>{emit({stage:'wall_deadline',status:'unavailable',activation:false});process.exit(2);},CHANNEL_LIMITS.wallMs);
 try{if(process.argv.length!==2)throw Error('No arguments supported');const {project,credentials}=loadBigQueryConfig();if(project!=='gf-full-data')throw Error('Unexpected project');const bigquery=new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0}),[ds]=await bigquery.dataset('square_data').getMetadata();if(!await validateSquareChannels({bigquery,project,location:ds.location,emit}))process.exitCode=2;}catch(e){emit({stage:'configuration',status:'unavailable',...safeSqlFailure(e)});process.exitCode=2;}finally{clearTimeout(timer);closeSync(fd);}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)await main();

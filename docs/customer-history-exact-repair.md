# Exact customer-history duplicate repair — review only

**Do not execute this command yet.** This document prepares the repair for review;
it does not authorize any production mutation, guard migration, merge, deployment,
identity activation or collector action.

The operator reports the following production diagnostic results. The agent has
not independently queried production:

| Evidence | Confirmed value |
| --- | ---: |
| Markers / metadata variants / intended metadata markers | 2 / 1 / 2 |
| Original link rows | 116930 |
| Distinct original order keys | 58465 |
| Duplicate keys / identical duplicate keys | 58465 / 58465 |
| Conflicting duplicate keys / invalid mapping keys | 0 / 0 |
| Distinct WW / USD / Shopify keys | 39176 / 4322 / 14967 |

Both reported markers have the intended ready state, dates 1900-01-01 through
2026-10-19 and mapping_count 58465. Keep exactly the marker at
2026-10-22T07:31:49.447Z; remove the redundant marker at
2026-10-22T07:32:17.761Z. Snapshot: `history-20261022-billing-v3`.

Every key has two identical complete mappings. The smallest row repair keeps one
copy of each complete mapping and the explicitly selected original marker.
Historical job evidence is unavailable: **overlap remains unproven**.

## Ordering and prerequisites

1. Review this command and the production aggregate evidence, including the
   chosen original timestamp. Obtain explicit production-mutation authorization
   before setting its approval variable. The current request authorizes
   preparation only.
2. Quiesce **all output writers and publication launch paths across hosts**:
   Render instances/replicas, cron/schedulers, ad hoc shells and automation. Check
   local publisher processes and project-wide active BigQuery jobs freshly.
   No old publisher may remain running or be launched during backup, repair or
   validation. Do not recollect, reset checkpoints, restart collectors or change
   any collection evidence. Keep this publication maintenance window open through
   successful post-repair validation. An environment acknowledgement alone does
   not verify remote hosts; the operator must establish and hold this condition.
3. The guard migration stays separate:
   [identity-publication-guard.sql](sql/identity-publication-guard.sql).
   While all publishers are quiescent and previous publication jobs are terminal,
   separately review/authorize provisioning its **one unpartitioned singleton**
   in `customer_identity`, in the same project/location. Wait for that migration
   job to finish successfully, and validate exactly one `publication` row with a
   non-null, nonnegative integer generation. Do not append a seed, reseed, use
   IF NOT EXISTS, or provision it inside the repair command. If it already exists,
   inspect it instead. The repair requires the guard and updates its generation
   within the same transaction as the row repair.
4. Select an **existing, separately reviewed restricted backup dataset in the
   same project/location**, different from `customer_identity`. Verify effective
   dataset plus inherited project/folder/organization IAM, group membership,
   authorized views/routines/datasets and recovery-reader access. It must have no
   broad specialGroup/domain/public/authorized-resource grants and no default
   table expiration; the script rejects these visible grants and table TTLs.
   Dataset metadata cannot prove inherited IAM is restricted: the explicit ACL
   acknowledgement covers that separate review. This command never creates a
   dataset, changes permissions, exports rows or deletes backups.
5. Fresh active-job inspection requires **project-wide jobs.listAll visibility**
   for JOBS_BY_PROJECT in the output dataset's region. Historical job evidence
   being unavailable does not waive this check. If current job visibility is
   unavailable, this command stops before backing up or repairing rows.
   Do not substitute JOBS_BY_USER or a blind operator override. Resolve the
   visibility/maintenance prerequisite separately.
6. Confirm the existing Render app root has the installed BigQuery SDK and normal
   credentials. No fetch, installation, deployment or application code change is
   required. Source column names/types are checked before any write.

For eventual release, create/validate the guard **before deploying guarded
publishers**, and keep all old writers quiescent during that transition. The guard
does not protect against an old publisher that ignores it. This repair does not
deploy the fix or authorize resuming publication.

## One self-contained Render command

This block is deliberately inert with `NOT_AUTHORIZED`. **Only after separate
authorization**, replace that value with
`history-20261022-billing-v3:approved`, fill in the approved restricted dataset,
set the two acknowledgement strings to their indicated values after actually
performing those reviews, and set QUIESCED_AT to the actual UTC timestamp of the
completed all-host quiescence check. It must be less than five minutes old both at
startup and immediately before repair. Keep credentials in the existing
environment; do not paste them into the command.

The eventual command creates exactly two new, uniquely named, restricted backup
tables for this snapshot, without overwriting existing tables. It validates the
full pre-repair **multisets**, including NULLs and all mapping fields, against both
backups before deleting anything. Backup rows include both original marker
timestamps and both copies of every mapping, and remain restricted after success
or failure. There is no automatic expiration or cleanup added by this command.

Fresh local process and active-job checks run before backups and again immediately
before repair. The active-job gate conservatively requires **zero other active
jobs of any type** in the project/region; unrelated work can block it. It does not
cancel other jobs. The repair transaction asserts that the final fresh checks are
at most 15 seconds old. The all-host quiescence requirement is essential because a
point-in-time job check cannot prevent a later unguarded submission.

Limits: 1 GB per-query billed-byte cap; 15s job checks; 30s precondition/backup/
validation jobs; 60s repair job; 230s owned overall work, 235s watchdog, 240s shell
backstop with a 5s kill grace. A minimum 95s reserve is required before submitting
repair. No SDK retries, repair replay, fallback query or implicit migration.
Timeouts/lost responses after submission remain **unknown outcomes**.

The command emits only aggregate validation and recovery coordinates (backup table
names and job IDs), never customer/order IDs, canonical references, emails, SQL,
raw parameters, error bodies or credentials.

```sh
HISTORY_REPAIR_APPROVAL='NOT_AUTHORIZED' \
HISTORY_REPAIR_BACKUP_DATASET='REPLACE_WITH_REVIEWED_RESTRICTED_DATASET' \
HISTORY_REPAIR_WRITERS_ACK='SET_ONLY_AFTER_ALL_OUTPUT_WRITERS_ARE_QUIESCENT' \
HISTORY_REPAIR_BACKUP_ACL_ACK='SET_ONLY_AFTER_EFFECTIVE_ACL_REVIEW' \
HISTORY_REPAIR_QUIESCED_AT='REPLACE_WITH_ACTUAL_FRESH_UTC_TIMESTAMP' \
timeout --signal=TERM --kill-after=5s 240s node --input-type=module <<'NODE'
import {BigQuery} from '@google-cloud/bigquery';
import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';

const SNAPSHOT='history-20261022-billing-v3';
const KEEP='2026-10-22T07:31:49.447Z';
const OTHER='2026-10-22T07:32:17.761Z';
let stage='authorization',active,repairId=null,submitted=false,committed=false,stopped=false;
const deadline=Date.now()+230000;
const safeId=x=>/^[A-Za-z0-9_-]{1,128}$/.test(x||'')?x:null;
const reportFailure=()=>{
  console.error(JSON.stringify({status:'stopped',stage,repair_job_id:safeId(repairId),
    commit_outcome:committed?'committed':submitted?'unknown':'not_submitted',
    instruction:submitted?'Do not rerun. Reconcile this exact repair job and retain backups.':'No repair submitted. Retain any backups; inspect the failed precondition.'}));
};
const stop=()=>{stopped=true;active?.cancel({maxRetries:0}).catch(()=>{});};
const watchdog=setTimeout(()=>{stop();reportFailure();process.exit(2);},235000);
process.once('SIGTERM',stop);process.once('SIGINT',stop);
const owned=()=>{if(stopped||Date.now()>=deadline)throw Error('stopped');};
const bounded=async(work,ms=20000)=>{
  owned();let timer;
  try{return await Promise.race([work(),new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(Error('bounded_stop')),Math.max(1,Math.min(ms,deadline-Date.now())));
  })]);}finally{clearTimeout(timer);}
};
const requireThat=value=>{if(!value)throw Error('precondition');};
try{
  requireThat(process.env.HISTORY_REPAIR_APPROVAL===SNAPSHOT+':approved');
  requireThat(process.env.HISTORY_REPAIR_WRITERS_ACK==='all-output-writers-quiesced-across-hosts');
  requireThat(process.env.HISTORY_REPAIR_BACKUP_ACL_ACK==='restricted-including-inherited-iam');
  const quiescedAt=Date.parse(process.env.HISTORY_REPAIR_QUIESCED_AT||'');
  const freshAttestation=()=>requireThat(Number.isFinite(quiescedAt)&&Date.now()>=quiescedAt&&Date.now()-quiescedAt<300000);
  freshAttestation();
  const backupDataset=process.env.HISTORY_REPAIR_BACKUP_DATASET;
  requireThat(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(backupDataset||'')&&backupDataset!=='customer_identity');
  const credentials=process.env.GOOGLE_SERVICE_ACCOUNT_JSON?JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON):undefined;
  const project=process.env.GOOGLE_PROJECT_ID||credentials?.project_id;
  requireThat(/^[A-Za-z0-9_-]+$/.test(project||''));
  const bq=new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0});
  const quote=String.fromCharCode(96);
  const fq=(dataset,table)=>quote+project+'.'+dataset+'.'+table+quote;
  const markerTable=fq('customer_identity','identity_snapshots');
  const linkTable=fq('customer_identity','identity_order_links');
  const guardTable=fq('customer_identity','identity_publication_guard');
  const markerFields=['snapshot_id','state','start_date','end_date','mapping_count','created_at'];
  const linkFields=['snapshot_id','source_store','source_order_id','source_customer_id','canonical_customer_ref','resolution','financial_status','cancelled','conflicting_email','shared_email'];
  const mc=markerFields.join(','),lc=linkFields.join(',');
  const target="snapshot_id='"+SNAPSHOT+"'";
  stage='schema_and_restricted_backup';
  const [[sourceMeta],[backupMeta],[markerMeta],[linkMeta]]=await bounded(()=>Promise.all([
    bq.dataset('customer_identity').getMetadata(),bq.dataset(backupDataset).getMetadata(),
    bq.dataset('customer_identity').table('identity_snapshots').getMetadata(),
    bq.dataset('customer_identity').table('identity_order_links').getMetadata()
  ]));
  const location=sourceMeta.location;
  requireThat(/^[A-Za-z0-9-]+$/.test(location||'')&&String(backupMeta.location).toLowerCase()===location.toLowerCase());
  // This rejects known broad dataset grants. The signed-off ACL precondition
  // ALSO covers inherited project/folder/org IAM, groups and authorized access.
  requireThat(Array.isArray(backupMeta.access)&&backupMeta.access.length>0&&!Number(backupMeta.defaultTableExpirationMs||0));
  requireThat(!backupMeta.access.some(x=>x.domain||x.specialGroup||x.view||x.routine||x.dataset||
    ['allUsers','allAuthenticatedUsers'].includes(x.iamMember)||
    ['allUsers','allAuthenticatedUsers'].includes(x.userByEmail)));
  const normalType=t=>({INT64:'INTEGER',BOOL:'BOOLEAN'}[t]||t);
  const schema=(meta,names,types)=>requireThat(meta.schema?.fields?.length===names.length&&names.every((n,i)=>{
    const f=meta.schema.fields.find(x=>x.name===n);
    return f&&normalType(f.type)===types[i]&&f.mode!=='REPEATED'&&!f.fields;
  }));
  schema(markerMeta,markerFields,['STRING','STRING','DATE','DATE','INTEGER','TIMESTAMP']);
  schema(linkMeta,linkFields,['STRING','STRING','STRING','STRING','STRING','STRING','STRING','BOOLEAN','BOOLEAN','BOOLEAN']);
  const suffix=Date.now()+'_'+randomUUID().replaceAll('-','');
  const markerBackupName='history_markers_'+suffix,linkBackupName='history_links_'+suffix;
  const bm=fq(backupDataset,markerBackupName),bl=fq(backupDataset,linkBackupName);
  repairId='history_dedup_repair_'+randomUUID().replaceAll('-','');
  // Recovery coordinates only. No query/parameters, credentials or row IDs.
  console.log(JSON.stringify({status:'recovery_coordinates',project,location,
    marker_backup:backupDataset+'.'+markerBackupName,link_backup:backupDataset+'.'+linkBackupName,
    repair_job_id:repairId}));

  const run=async(sql,{ms=20000,params={},mutation=false,isRepair=false,queryJobId}={})=>{
    owned();
    const jobId=queryJobId||(isRepair?repairId:'history_dedup_'+randomUUID().replaceAll('-',''));
    if(mutation)console.log(JSON.stringify({status:'submitting',stage,job_id:jobId}));
    active=bq.job(jobId,{location});
    if(isRepair)submitted=true;
    const [job]=await bounded(()=>bq.createQueryJob({query:sql,jobId,location,params,
      maximumBytesBilled:'1000000000',jobTimeoutMs:ms,useLegacySql:false,
      labels:{component:'history_repair',operation:isRepair?'deduplicate':mutation?'restricted_backup':'read_only'}}),ms+1000);
    active=job;let rows=[],next={},response;
    const end=Math.min(deadline,Date.now()+ms+1000);
    do{
      const [page,continuation,meta]=await bounded(()=>job.getQueryResults({
        ...next,autoPaginate:false,maxResults:10,timeoutMs:1000
      }),Math.max(1,end-Date.now()));
      owned();response=meta;
      if(meta?.jobComplete!==false)rows.push(...page);
      requireThat(rows.length<=10&&Date.now()<end);
      next=continuation;
    }while(next||response?.jobComplete===false);
    active=null;
    if(isRepair)committed=true;
    return rows;
  };
  const localPublisherCheck=async()=>{
    stage='local_publisher_check';
    const pids=await bounded(()=>readdir('/proc'),5000);let publishers=0,unreadable=0;
    for(const pid of pids.filter(x=>/^\d+$/.test(x))){
      try{
        const argv=(await bounded(()=>readFile('/proc/'+pid+'/cmdline'),1000)).toString('utf8').split('\0');
        if(argv.some(x=>/(?:^|\/)customer-identity\/(?:history|cli)\.js$/.test(x))&&argv.includes('publish'))publishers++;
      }catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')unreadable++;}
    }
    requireThat(publishers===0&&unreadable===0);
  };
  const activeJobCheck=async()=>{
    stage='project_active_job_check';
    // Requires project-wide jobs.listAll visibility. Do not replace this with
    // JOBS_BY_USER: that could hide a publisher under another principal.
    const id='history_dedup_jobs_'+randomUUID().replaceAll('-','');
    const sql="SELECT COUNT(*) active_jobs FROM "+quote+project+".region-"+location.toLowerCase()+".INFORMATION_SCHEMA.JOBS_BY_PROJECT"+quote+
      " WHERE state IN ('PENDING','RUNNING') AND job_id!=@self AND (parent_job_id IS NULL OR parent_job_id!=@self)";
    const rows=await run(sql,{queryJobId:id,ms:15000,params:{self:id}});
    requireThat(rows.length===1&&Number(rows[0].active_jobs)===0);
  };
  const freshChecks=async()=>{
    freshAttestation();await localPublisherCheck();await activeJobCheck();freshAttestation();return new Date().toISOString();
  };

  const capture=[
    "CREATE TEMP TABLE repair_markers AS SELECT "+mc+" FROM "+markerTable+" WHERE "+target+";",
    "CREATE TEMP TABLE repair_original_links AS SELECT "+lc+" FROM "+linkTable+" WHERE "+target+";",
    "CREATE TEMP TABLE repair_links AS SELECT DISTINCT "+lc+" FROM repair_original_links;",
    "CREATE TEMP TABLE repair_keys AS SELECT source_store,source_order_id,COUNT(*) copies FROM repair_original_links GROUP BY source_store,source_order_id;"
  ].join('\n');
  const mappingValidity=[
    "ASSERT NOT EXISTS(SELECT 1 FROM repair_links WHERE source_store IS NULL OR source_store NOT IN ('ww','usd','shopify') OR source_order_id IS NULL OR source_order_id='' OR canonical_customer_ref IS NULL OR NOT REGEXP_CONTAINS(canonical_customer_ref,r'^c_[A-Fa-f0-9]{64}$') OR resolution IS NULL OR resolution NOT IN ('matched','unmatched','ambiguous','unavailable')) AS 'Invalid mapping';",
    "ASSERT NOT EXISTS(SELECT 1 FROM repair_links GROUP BY source_store,source_order_id HAVING COUNT(*)>1) AS 'Conflicting complete mapping';",
    "ASSERT (SELECT COUNT(*) FROM repair_links)=58465 AND (SELECT COUNT(*) FROM repair_keys)=58465 AS 'Distinct mapping count changed';",
    "ASSERT (SELECT COUNT(*) FROM repair_links WHERE source_store='ww')=39176 AND (SELECT COUNT(*) FROM repair_links WHERE source_store='usd')=4322 AND (SELECT COUNT(*) FROM repair_links WHERE source_store='shopify')=14967 AS 'Distinct source totals changed';"
  ].join('\n');
  const beforeAssertions=[
    "ASSERT (SELECT COUNT(*) FROM repair_markers)=2 AS 'Expected exactly two markers';",
    "ASSERT (SELECT COUNT(*) FROM (SELECT DISTINCT state,start_date,end_date,mapping_count FROM repair_markers))=1 AS 'Marker metadata conflict';",
    "ASSERT (SELECT COUNT(*) FROM repair_markers WHERE state='ready' AND start_date=DATE '1900-01-01' AND end_date=DATE '2026-10-19' AND mapping_count=58465)=2 AS 'Intended metadata changed';",
    "ASSERT (SELECT COUNT(*) FROM repair_markers WHERE created_at=TIMESTAMP '"+KEEP+"')=1 AND (SELECT COUNT(*) FROM repair_markers WHERE created_at=TIMESTAMP '"+OTHER+"')=1 AS 'Marker timestamps changed';",
    "ASSERT (SELECT COUNT(*) FROM repair_original_links)=116930 AS 'Original row count changed';",
    "ASSERT (SELECT COUNT(*) FROM repair_keys WHERE copies>1)=58465 AND NOT EXISTS(SELECT 1 FROM repair_keys WHERE copies!=2) AS 'Duplicate key multiplicity changed';",
    mappingValidity,
    "ASSERT (SELECT COUNT(*) FROM (SELECT "+lc+",COUNT(*) copies FROM repair_original_links GROUP BY "+lc+" HAVING COUNT(*)=2))=58465 AS 'Mappings are not identical pairs';"
  ].join('\n');
  const equalSets=(left,right,label)=>[
    "ASSERT NOT EXISTS("+left+" EXCEPT DISTINCT "+right+") AS '"+label+" missing';",
    "ASSERT NOT EXISTS("+right+" EXCEPT DISTINCT "+left+") AS '"+label+" added';"
  ].join('\n');
  const backupEquality=[
    equalSets("SELECT "+mc+",COUNT(*) copies FROM repair_markers GROUP BY "+mc,
      "SELECT "+mc+",COUNT(*) copies FROM "+bm+" GROUP BY "+mc,'Marker backup'),
    equalSets("SELECT "+lc+",COUNT(*) copies FROM repair_original_links GROUP BY "+lc,
      "SELECT "+lc+",COUNT(*) copies FROM "+bl+" GROUP BY "+lc,'Link backup')
  ].join('\n');
  const guardAssertions="ASSERT (SELECT COUNT(*) FROM "+guardTable+")=1 AND (SELECT COUNTIF(guard_id='publication' AND generation IS NOT NULL AND generation>=0) FROM "+guardTable+")=1 AS 'Publication guard unavailable';";
  await freshChecks();
  stage='readonly_preconditions';
  await run("BEGIN TRANSACTION;\n"+capture+'\n'+beforeAssertions+'\n'+guardAssertions+"\nCOMMIT TRANSACTION;",{ms:30000});

  stage='restricted_marker_backup';
  await run("CREATE TABLE "+bm+" OPTIONS(labels=[('data_class','restricted'),('purpose','history_repair')]) AS SELECT "+mc+" FROM "+markerTable+" WHERE "+target,{ms:30000,mutation:true});
  stage='restricted_link_backup';
  await run("CREATE TABLE "+bl+" OPTIONS(labels=[('data_class','restricted'),('purpose','history_repair')]) AS SELECT "+lc+" FROM "+linkTable+" WHERE "+target,{ms:30000,mutation:true});
  // CREATE TABLE, no IF NOT EXISTS/OR REPLACE; no overwrite or automatic cleanup.
  // Assert exact multiset equality again inside the mutation transaction below.
  stage='backup_multiset_validation';
  await run("BEGIN TRANSACTION;\n"+capture+'\n'+beforeAssertions+'\n'+backupEquality+"\nCOMMIT TRANSACTION;",{ms:30000});

  const checkedAt=await freshChecks();
  stage='transactional_repair';
  requireThat(deadline-Date.now()>=95000);
  const repair=[
    "BEGIN TRANSACTION;",
    "ASSERT TIMESTAMP_DIFF(CURRENT_TIMESTAMP(),@checked_at,SECOND) BETWEEN 0 AND 15 AS 'Job and publisher checks stale';",
    guardAssertions,
    "UPDATE "+guardTable+" SET generation=generation+1 WHERE guard_id='publication' AND generation IS NOT NULL;",
    "ASSERT @@row_count=1 AS 'Publication guard unavailable';",
    capture,beforeAssertions,backupEquality,
    "CREATE TEMP TABLE retained_marker AS SELECT "+mc+" FROM repair_markers WHERE created_at=TIMESTAMP '"+KEEP+"';",
    "DELETE FROM "+linkTable+" WHERE "+target+";",
    "INSERT INTO "+linkTable+" ("+lc+") SELECT "+lc+" FROM repair_links;",
    "DELETE FROM "+markerTable+" WHERE "+target+";",
    "INSERT INTO "+markerTable+" ("+mc+") SELECT "+mc+" FROM retained_marker;",
    "ASSERT (SELECT COUNT(*) FROM "+linkTable+" WHERE "+target+")=58465 AS 'Link postcondition';",
    "ASSERT (SELECT COUNT(*) FROM "+markerTable+" WHERE "+target+")=1 AS 'Marker postcondition';",
    equalSets("SELECT "+lc+" FROM repair_links","SELECT "+lc+" FROM "+linkTable+" WHERE "+target,'Exact mapping set'),
    equalSets("SELECT "+mc+" FROM retained_marker","SELECT "+mc+" FROM "+markerTable+" WHERE "+target,'Original marker'),
    "COMMIT TRANSACTION;"
  ].join('\n');
  await run(repair,{ms:60000,params:{checked_at:BigQuery.timestamp(checkedAt)},mutation:true,isRepair:true});
  console.log(JSON.stringify({status:'repair_committed',repair_job_id:repairId}));

  stage='readonly_postrepair_validation';
  const post=[
    "BEGIN TRANSACTION;",capture,mappingValidity,
    "ASSERT (SELECT COUNT(*) FROM repair_original_links)=58465 AND NOT EXISTS(SELECT 1 FROM repair_keys WHERE copies!=1) AS 'Postrepair duplicate links';",
    "ASSERT (SELECT COUNT(*) FROM repair_markers)=1 AS 'Postrepair marker count';",
    "ASSERT (SELECT COUNT(*) FROM "+bl+")=116930 AND (SELECT COUNT(*) FROM "+bm+")=2 AS 'Backup counts changed';",
    equalSets("SELECT "+lc+" FROM repair_original_links","SELECT DISTINCT "+lc+" FROM "+bl,'Preserved complete mappings'),
    equalSets("SELECT "+mc+" FROM repair_markers","SELECT "+mc+" FROM "+bm+" WHERE created_at=TIMESTAMP '"+KEEP+"'",'Preserved original marker'),
    "COMMIT TRANSACTION;",
    "SELECT 'validated' status,(SELECT COUNT(*) FROM repair_markers) marker_count,(SELECT COUNT(*) FROM repair_original_links) total_link_rows,(SELECT COUNT(*) FROM repair_keys) distinct_order_keys,(SELECT COUNTIF(copies>1) FROM repair_keys) duplicate_key_count,0 conflicting_duplicate_keys,0 invalid_mapping_keys,(SELECT COUNT(*) FROM repair_links WHERE source_store='ww') ww,(SELECT COUNT(*) FROM repair_links WHERE source_store='usd') usd,(SELECT COUNT(*) FROM repair_links WHERE source_store='shopify') shopify,TRUE mapping_set_preserved,TRUE original_marker_preserved;"
  ].join('\n');
  const result=await run(post,{ms:30000});requireThat(result.length===1);
  console.log(JSON.stringify(result[0]));
}catch(e){stop();reportFailure();process.exitCode=2;}
finally{clearTimeout(watchdog);process.off('SIGTERM',stop);process.off('SIGINT',stop);}

NODE
```

The acknowledgement values checked by the script are
`all-output-writers-quiesced-across-hosts` and
`restricted-including-inherited-iam`. They are procedural attestations, not a
replacement for those checks or production authorization.

For a separate line-by-line SQL review, see
[the exact generated transaction](sql/customer-history-exact-duplicate-repair.sql).
That rendering uses project/backup-name placeholders only; it must not bypass
the self-contained command\'s preflight and backup checks.

## Expected result and post-repair check

The same command runs a separate, read-only consistent post-repair transaction
after observing terminal repair success. Its final aggregate record must be:

```json
{"status":"validated","marker_count":1,"total_link_rows":58465,"distinct_order_keys":58465,"duplicate_key_count":0,"conflicting_duplicate_keys":0,"invalid_mapping_keys":0,"ww":39176,"usd":4322,"shopify":14967,"mapping_set_preserved":true,"original_marker_preserved":true}
```

It establishes exact full-field set equality to the **DISTINCT backup mapping
set**, the exact original ready marker (including created_at), no duplicates,
unchanged intended metadata and source totals. Backups must still contain
116930 link rows and both original markers.

The transaction deletes 116930 targeted link rows and inserts 58465 unchanged
distinct mappings; it deletes 2 targeted markers and inserts the exact original
marker once. All output deletes/reads/inserts are scoped to
`history-20261022-billing-v3`; only the operational guard generation changes
besides that snapshot and the two new backups. No collection/evidence/checkpoint
table is read or written by the repair.

For an independent follow-up read, use the existing self-contained aggregate
diagnostic in
[customer-history-publication-repair.md](customer-history-publication-repair.md#one-bounded-read-only-render-diagnostic)
once. Expect the same 1 marker, 58465 rows/keys, zero duplicates/conflicts/invalid
keys and the original timestamp; source row totals now equal the distinct totals
above. Historical job evidence may still be unavailable and is not needed to
claim the row postconditions. Do not use the expensive shared check command as
a substitute for these aggregates, and do not activate identity mode.

If any precondition changes, backups fail, current jobs are hidden or active, or
the all-host writer hold cannot be maintained, stop before repair and review
again. On a timeout, signal, lost response or nonzero shell exit, do **not rerun
the mutation command**. Use the printed repair job ID and location to inspect
that exact job read-only and establish its terminal outcome. No job ID printed
means there was no repair submission from this process. A
`repair_committed` record followed by a post-check failure means the commit
succeeded but validation is incomplete; do not repair again. Retain both backup
tables and the recovery coordinates until separately reviewed retention/cleanup
is authorized. No rollback or restoration is automatic.

## Preparation validation and limits

The command's JavaScript parsed successfully, and an in-memory SDK stub exercised
nine cases: successful preparation/repair/post-check flow; missing authorization;
broad visible backup ACL; local publisher; active job; stale-count assertion;
backup mismatch; unknown repair outcome; and failure after commit. All passed the
expected stop/no-replay behavior without contacting any external service.

These are preparation checks, not BigQuery SQL execution or production
verification. The workspace shell connection was unavailable, so this
documentation-only follow-up has not rerun shell/acceptance/browser gates. The
application change's previously recorded gates remain 676 acceptance tests and
browser acceptance passed. No production repair, backup creation, guard
migration, merge, deployment or activation was executed.

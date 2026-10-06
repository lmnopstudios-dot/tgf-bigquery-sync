import {randomUUID} from 'node:crypto';
import {BigQueryTimestamp} from '@google-cloud/bigquery';
import {ensureControl,acquire} from '../ops/collector-runner.js';
// Both sources share the existing warehouse lock. Every CLI, backfill and
// scheduler entrypoint passes through here; no inherited environment bypass.
export async function governedMetaRun({bigquery,project,source,run,now=new Date()}){
  const runId=randomUUID();await ensureControl(bigquery,project);
  // The existing ASSERT + append-only run ledger alone is not an exclusive
  // mutex under concurrent BigQuery inserts. Mutate a pre-created singleton
  // control row so concurrent transactions conflict, including across sources.
  await bigquery.query({query:`CREATE TABLE IF NOT EXISTS \`${project}.oracle_ops.meta_collection_lock\` AS SELECT CAST(NULL AS STRING) owner, TIMESTAMP '1970-01-01 00:00:00+00' lease_until`,useLegacySql:false});
  await bigquery.query({query:`BEGIN TRANSACTION; UPDATE \`${project}.oracle_ops.meta_collection_lock\` SET owner=@runId,lease_until=TIMESTAMP_ADD(CURRENT_TIMESTAMP(),INTERVAL 6 HOUR) WHERE owner IS NULL OR lease_until<CURRENT_TIMESTAMP(); ASSERT @@row_count=1 AS 'Meta/Instagram collector already running'; COMMIT TRANSACTION;`,params:{runId},types:{runId:'STRING'},useLegacySql:false});
  const release=()=>bigquery.query({query:`UPDATE \`${project}.oracle_ops.meta_collection_lock\` SET owner=NULL,lease_until=TIMESTAMP '1970-01-01 00:00:00+00' WHERE owner=@runId`,params:{runId},types:{runId:'STRING'},useLegacySql:false});
  try{await acquire(bigquery,project,source,runId,{now});}catch(error){await release();throw error;}

  try{
    const result=await run();const ends=(result.results||[]).map(r=>r.end).filter(Boolean).sort(),starts=(result.results||[]).map(r=>r.start).filter(Boolean).sort();
    const params={runId,source,start:starts[0]||null,end:ends.at(-1)||null,counts:JSON.stringify(result.results?.map(r=>r.counts||{})),finishedAt:new BigQueryTimestamp(new Date())},types={runId:'STRING',source:'STRING',start:'DATE',end:'DATE',counts:'STRING',finishedAt:'TIMESTAMP'};
    await bigquery.query({query:`BEGIN TRANSACTION; UPDATE \`${project}.oracle_ops.collector_runs\` SET status='succeeded',window_start=@start,window_end=@end,row_counts_json=@counts,finished_at=@finishedAt WHERE run_id=@runId AND status='running'; MERGE \`${project}.oracle_ops.collector_state\` t USING (SELECT @source source) s ON t.source=s.source WHEN MATCHED THEN UPDATE SET successful_coverage_start=COALESCE(t.successful_coverage_start,@start),successful_watermark=GREATEST(COALESCE(t.successful_watermark,@end),@end),last_success_at=@finishedAt,last_run_id=@runId,last_status='succeeded',row_counts_json=@counts WHEN NOT MATCHED THEN INSERT VALUES(@source,@start,@end,@finishedAt,@runId,'succeeded',@counts); COMMIT TRANSACTION;`,params,types,useLegacySql:false});
    return {...result,run_id:runId};
  }catch(error){await bigquery.query({query:`UPDATE \`${project}.oracle_ops.collector_runs\` SET status='failed',error=@error,finished_at=CURRENT_TIMESTAMP() WHERE run_id=@runId AND status='running'; UPDATE \`${project}.oracle_ops.collector_state\` SET last_status='failed',last_run_id=@runId WHERE source=@source`,params:{runId,source,error:String(error.code||'COLLECTION_FAILED').replace(/[^A-Z0-9_]/g,'').slice(0,80)},types:{runId:'STRING',source:'STRING',error:'STRING'},useLegacySql:false});throw error;}finally{await release();}
}

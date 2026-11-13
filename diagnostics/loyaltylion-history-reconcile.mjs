// Read-only aggregate reconciliation; never releases a guard or retries a run.
import {createBigQueryClient} from '../bigquery/client.js';
import {loadLoyaltyConfig} from '../loyaltylion/runtime-config.js';
const [run]=process.argv.slice(2);
if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(run||''))throw Error('Run UUID required');
try{
 const c=loadLoyaltyConfig(),{bigquery,project}=createBigQueryClient();
 if(![project,c.dataset].every(x=>/^[\w-]+$/.test(x)))throw Error('Invalid identifier');
 const [meta]=await bigquery.dataset(c.dataset).getMetadata();
 const [rows]=await bigquery.query({query:`SELECT
  (SELECT COUNT(*) FROM \`${project}.${c.dataset}.coverage_windows\` WHERE program_id=@program AND run_id=@run AND status='complete') complete_markers,
  (SELECT COUNT(*) FROM \`${project}.${c.dataset}.customer_snapshots\` WHERE program_id=@program AND run_id=@run) roster_rows,
  (SELECT COUNT(*) FROM \`${project}.${c.dataset}.points_transactions\` WHERE program_id=@program AND run_id=@run) new_point_rows,
  (SELECT COUNT(*) FROM \`${project}.${c.dataset}.sync_guard\` WHERE program_id=@program) guard_rows,
  (SELECT COUNTIF(holder IS NOT NULL) FROM \`${project}.${c.dataset}.sync_guard\` WHERE program_id=@program) held_guards`,params:{program:c.program_id,run},types:{program:'STRING',run:'STRING'},location:meta.location,useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:15000});
 console.log(JSON.stringify({read_only:true,automatic_replay:false,guard_changed:false,...rows[0]}));
}catch{console.error(JSON.stringify({read_only:true,status:'reconciliation_unavailable'}));process.exitCode=1;}

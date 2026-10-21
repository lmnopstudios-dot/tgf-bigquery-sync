import {spawn} from 'node:child_process';
import {mkdir, rmdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const collector = fileURLToPath(new URL('./history.js', import.meta.url));
const integer = n => Number.isSafeInteger(n) && n >= 0;
const invalid = () => { throw Error('invalid_arguments'); };
export function parseRunnerArgs(args) {
  const o = {dataset:'customer_identity', batches:20, 'invocation-ms':650000};
  const seen = new Set();
  for (const arg of args) {
    if (arg === '--apply' && !seen.has('apply')) { seen.add('apply'); continue; }
    const m = /^--(source|adapter|dataset|revision|batches|max-invocations|total-ms|invocation-ms)=(.+)$/.exec(arg);
    if (!m || seen.has(m[1])) invalid();
    seen.add(m[1]); o[m[1]] = m[2];
  }
  if (!seen.has('apply') || !['ww','usd','shopify'].includes(o.source) ||
      !['roster','native','metorik_orders','metorik_customers','shopify'].includes(o.adapter) ||
      (o.adapter !== 'roster' && (o.adapter === 'shopify') !== (o.source === 'shopify')) ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(o.dataset) ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(o.revision || '')) invalid();
  for (const [key,max] of [['batches',1200],['max-invocations',1000],['total-ms',86400000],['invocation-ms',650000]]) {
    if (!/^\d+$/.test(String(o[key]))) invalid();
    o[key] = Number(o[key]);
    if (!integer(o[key]) || o[key] < 1 || o[key] > max) invalid();
  }
  return o;
}
export function collectorArgs(o) {
  return ['collect', ...['source','adapter','dataset','revision','batches'].map(k=>`--${k}=${o[k]}`), '--apply'];
}
// Strict, bounded aggregate protocol. Never forward child output to the operator.
function resultFrom(output, o) {
  let r;
  try { r = JSON.parse(output.trim()); } catch { return null; }
  if (!r || Array.isArray(r) || typeof r !== 'object') return null;
  if (r.status === 'failed') {
    if (!integer(r.committed_records) || !integer(r.committed_batches) ||
        r.committed_batches > o.batches || r.committed_records > o.batches * 100 ||
        !['unknown','committed','not_committed'].includes(r.commit_outcome)) return null;
    return {status:'failed', records:r.committed_records, batches:r.committed_batches,
      unknown:r.commit_outcome === 'unknown',
      uncertain:['requested','acknowledged','unverified'].includes(r.cancellation_state)};
  }
  if (!['complete','resumable'].includes(r.status) || r.source !== o.source || r.adapter !== o.adapter ||
      !integer(r.records) || !integer(r.batches) || r.batches > o.batches ||
      r.records > o.batches * 100 || (r.records > 0 && r.batches === 0) ||
      !Object.keys(r).every(k=>['source','adapter','status','records','batches','requests','bytes','warehouse_commits'].includes(k)) ||
      ['requests','bytes','warehouse_commits'].some(k=>k in r && !integer(r[k]))) return null;
  return {status:r.status, records:r.records, batches:r.batches};
}
export async function runHistory(o, {childPath=collector, lockRoot='/tmp', graceMs=5000, log=r=>console.log(JSON.stringify(r))}={}) {
  // Fixed Linux host directory; independent of TMPDIR, project env aliases,
  // checkout path, batch size and runner bounds. Conservatively locks across projects.
  const key = createHash('sha256').update(JSON.stringify([o.dataset,o.source,o.adapter,o.revision])).digest('hex');
  const lock = join(lockRoot, `customer-history-runner-${key}.lock`);
  try { await mkdir(lock, {mode:0o700}); } catch { throw Error('concurrent_or_uncertain_run'); }
  let active, stopped, retainLock=false, totalRecords=0, invocations=0;
  const started=performance.now();
  const stop = reason => { stopped ||= reason; active?.kill('SIGTERM'); };
  const term=()=>stop('terminated');
  process.on('SIGTERM',term); process.on('SIGINT',term);
  const deadline=setTimeout(()=>stop('total_deadline'),o['total-ms']);
  const report = (status, extra={}) => log({timestamp:new Date().toISOString(),source:o.source,adapter:o.adapter,
    invocation:invocations,status,this_run_reported_committed_records:totalRecords,elapsed_ms:Math.round(performance.now()-started),...extra});
  try {
    report('started');
    while (!stopped && invocations < o['max-invocations']) {
      if (performance.now()-started >= o['total-ms']) { stopped='total_deadline'; break; }
      invocations++;
      const invocationStart=performance.now();
      const outcome=await new Promise(resolve=>{
        let output='', overflow=false, timer, escalation, spawnError=false, terminating=false;
        const child=spawn(process.execPath,[childPath,...collectorArgs(o)],{stdio:['ignore','pipe','pipe'],shell:false});
        active=child;
        const terminate = reason => {
          if (terminating) return;
          terminating=true;
          stop(reason);
          if (!escalation) escalation=setTimeout(()=>{retainLock=true; child.kill('SIGKILL');},graceMs);
        };
        // Termination is also escalated if it came from the outer deadline/signal.
        const watch=setInterval(()=>{if(stopped)terminate(stopped);},10);
        timer=setTimeout(()=>terminate('invocation_timeout'),o['invocation-ms']);
        const receive=chunk=>{
          if (Buffer.byteLength(output)+chunk.length > 16384) { overflow=true; terminate('invalid_result'); }
          else output+=chunk.toString('utf8');
        };
        child.stdout.on('data',receive); child.stderr.on('data',receive);
        child.on('error',()=>{spawnError=true;});
        child.on('close',(code,signal)=>{
          clearTimeout(timer); clearTimeout(escalation); clearInterval(watch); active=null;
          resolve({code,signal,r:overflow?null:resultFrom(output,o),spawnError});
        });
      });
      const {r}=outcome;
      const records=r?.records ?? null;
      if (records !== null) totalRecords+=records;
      const reason=stopped || (outcome.spawnError?'child_start_failed':outcome.signal?'child_signal':
        outcome.code!==0?'child_nonzero':!r?'invalid_result':r.unknown?'unknown_commit_outcome':
        r.status==='failed'?'collector_failed':r.status==='resumable'&&(!r.records||!r.batches)?'no_progress':null);
      if (r?.unknown || r?.uncertain || stopped || outcome.signal || !r || (outcome.code !== 0 && r.status !== 'failed')) retainLock=true;
      report(reason || r.status,{result:r?.status || 'invalid',records_committed:records,
        commit_outcome:r?.unknown?'unknown':records===null?'unverified':'reported_committed',
        invocation_elapsed_ms:Math.round(performance.now()-invocationStart)});
      if (reason) return {status:reason,exitCode:2};
      if (r.status==='complete') return {status:'complete',exitCode:0};
    }
    const status=stopped || 'invocation_cap'; report(status); return {status,exitCode:2};
  } finally {
    clearTimeout(deadline); process.off('SIGTERM',term); process.off('SIGINT',term);
    if (!retainLock) await rmdir(lock);
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  Promise.resolve().then(()=>runHistory(parseRunnerArgs(process.argv.slice(2))))
    .then(r=>{process.exitCode=r.exitCode;})
    .catch(error=>{console.error(JSON.stringify({timestamp:new Date().toISOString(),status:
      ['invalid_arguments','concurrent_or_uncertain_run'].includes(error.message)?error.message:'runner_stopped'}));process.exitCode=2;});
}

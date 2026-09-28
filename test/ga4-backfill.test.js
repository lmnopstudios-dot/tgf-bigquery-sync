import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBackfillArgs, plannedChunks, runBackfill } from '../ga4/backfill.js';

test('historical backfill is bounded and resumes after the committed cursor', async () => {
  const options = parseBackfillArgs(['--start','2025-01-01','--end','2025-06-30','--chunk-days','31','--max-chunks','2','--resume-after','2025-01-31']);
  assert.deepEqual(plannedChunks(options), [{ startDate: '2025-02-01', endDate: '2025-03-03' }, { startDate: '2025-03-04', endDate: '2025-04-03' }]);
  const called = []; const result = await runBackfill({ options, sync: async chunk => called.push(chunk) });
  assert.equal(called.length, 2); assert.equal(result.resume_after, '2025-04-03'); assert.match(result.next_command, /--resume-after 2025-04-03/);
  assert.throws(() => parseBackfillArgs(['--start','2025-01-01','--end','2025-02-01','--chunk-days','32']), /between 1 and 31/);
  assert.throws(() => parseBackfillArgs([]), /never infer/);
});

test('a failed chunk reports atomic resume state and previously committed chunks', async () => {
  const options = parseBackfillArgs(['--start','2022-08-18','--end','2022-11-01','--chunk-days','31','--max-chunks','3']);
  let calls = 0;
  await assert.rejects(runBackfill({ options, sync: async () => { if (++calls === 2) throw new Error('reconciliation failed'); } }), error => {
    assert.equal(error.status.earlier_chunks_committed, true);
    assert.deepEqual(error.status.committed_chunks, [{ startDate: '2022-08-18', endDate: '2022-09-17' }]);
    assert.deepEqual(error.status.failed_chunk, { startDate: '2022-09-18', endDate: '2022-10-18' });
    assert.match(error.status.next_command, /--resume-after 2022-09-17/);
    return true;
  });
});

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

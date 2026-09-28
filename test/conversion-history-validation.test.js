import assert from 'node:assert/strict';
import test from 'node:test';
import { runValidation } from '../diagnostics/conversion-history-validation.js';

test('validator clearly reports pre-backfill tables as absent without querying them', async () => {
  let queried = false;
  const bigquery = {
    dataset: (_name, options) => ({
      getMetadata: async () => [{ location: 'US' }],
      table: name => ({ exists: async () => [name === 'unrelated'] })
    }),
    query: async () => { queried = true; throw new Error('raw not found'); }
  };
  const result = await runValidation({ bigquery, project: 'p', start: '2025-11-20', end: '2025-11-26' });
  assert.equal(result.state, 'PRE_BACKFILL_TABLES_ABSENT');
  assert.deepEqual(result.missing_tables, ['session_conversion_by_device','session_conversion_by_device_source']);
  assert.equal(queried, false);
});

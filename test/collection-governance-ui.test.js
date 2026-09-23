import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollectionGovernanceActions } from '../public/oracle/collection-governance.js';

function fixture({ group = 'collaboration', name = 'Sammi', confirm = true, error = null } = {}) {
  const calls = [], refreshes = [];
  const api = async (path, options) => { calls.push({ path, options }); if (error) throw new Error(error); };
  const actions = createCollectionGovernanceActions({ api, confirmAction: () => confirm, getCollection: () => ({ collection_id: '123', title: 'Sammi' }), fields: { group: { value: group }, collaborationName: { value: name }, note: { value: 'approved' } }, refreshDetail: async () => refreshes.push('detail'), refreshList: async () => refreshes.push('list') });
  return { actions, calls, refreshes };
}

test('collaboration save posts the governed API contract and refreshes detail and summary', async () => {
  const f = fixture(); const result = await f.actions.save();
  assert.equal(result.message, 'Saved collaboration classification for Sammi.');
  assert.deepEqual(f.calls, [{ path: '/collection-classifications/classify', options: { method: 'POST', body: JSON.stringify({ collection_id: '123', collection_title: 'Sammi', collection_group: 'collaboration', collaboration_name: 'Sammi', note: 'approved' }) } }]);
  assert.deepEqual(f.refreshes, ['detail', 'list']);
});

test('cancelled confirmation sends no write and server errors cannot produce false success', async () => {
  const cancelled = fixture({ confirm: false }); assert.deepEqual(await cancelled.actions.save(), { cancelled: true }); assert.equal(cancelled.calls.length, 0);
  const failed = fixture({ error: 'Invalid CSRF token' }); await assert.rejects(failed.actions.save(), /Invalid CSRF token/); assert.deepEqual(failed.refreshes, []);
});

test('other uses the exact governed value without requiring or sending a collaboration name', async () => {
  const f = fixture({ group: 'other', name: '' }); await f.actions.save();
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { collection_id: '123', collection_title: 'Sammi', collection_group: 'other', collaboration_name: null, note: 'approved' });
});

test('change reuses classify and revoke uses its existing endpoint, then both refresh views', async () => {
  const changed = fixture({ group: 'other' }); await changed.actions.save(); assert.equal(changed.calls[0].path, '/collection-classifications/classify');
  const revoked = fixture(); const result = await revoked.actions.revoke('cc_active', { collection_id: '123', title: 'Sammi' });
  assert.deepEqual(revoked.calls[0], { path: '/collection-classifications/revoke', options: { method: 'POST', body: '{"classification_id":"cc_active","collection_id":"123"}' } });
  assert.equal(result.message, 'Revoked collection classification for Sammi.'); assert.deepEqual(revoked.refreshes, ['detail', 'list']);
});

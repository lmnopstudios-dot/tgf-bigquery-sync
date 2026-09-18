import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertReadOnly, assertSafeOutput, buildQueries, classifyPostcode, compileReport,
  governanceTier, normalizePostcode, runDiagnostic
} from '../diagnostics/woo-postcode-country-feasibility.js';

test('normalization is in-memory and does not leak through report output', () => {
  assert.equal(normalizePostcode(' sw1a  1aa '), 'SW1A1AA');
  const output = compileReport([{ postal_input: 'sw1a 1aa', actual_country: 'GB', is_holdout: true }], []);
  assert.doesNotMatch(JSON.stringify(output), /SW1A|postal_input|sw1a 1aa/i);
});

test('known distinctive country syntax is evaluated without using its label', () => {
  assert.deepEqual(classifyPostcode('SW1A 1AA'), { rule_id: 'GB_UK_FULL', country: 'GB' });
  assert.deepEqual(classifyPostcode('K1A 0B1'), { rule_id: 'CA_FSA_LDU', country: 'CA' });
  assert.deepEqual(classifyPostcode('D02 X285'), { rule_id: 'IE_EIRCODE_ROUTING', country: 'IE' });
  assert.equal(classifyPostcode('SW1A 1AA').country, classifyPostcode('SW1A 1AA').country);
});

test('ambiguous numeric and Crown Dependency formats are rejected', () => {
  for (const value of ['1234', '12345', '90210', 'JE2 3AA', 'GY1 1AA', 'IM1 2AB', '75008']) assert.equal(classifyPostcode(value), null);
});

test('Tier A enforces precision, meaningful sample size and holdout size', () => {
  assert.equal(governanceTier({ predictions: 1000, precision: .999, holdout_predictions: 100, holdout_precision: 1 }), 'A');
  assert.equal(governanceTier({ predictions: 1000, precision: .998, holdout_predictions: 100, holdout_precision: 1 }), 'B');
  assert.equal(governanceTier({ predictions: 1, precision: 1, holdout_predictions: 1, holdout_precision: 1 }), 'B');
  assert.equal(governanceTier({ predictions: 1000, precision: 1, holdout_predictions: 29, holdout_precision: 1 }), 'B');
});

test('holdout, confusion and unknown simulation are aggregate and correct', () => {
  const labelled = [];
  for (let i = 0; i < 100; i++) labelled.push({ postal_input: 'SW1A 1AA', actual_country: i === 99 ? 'CA' : 'GB', is_holdout: i < 30 });
  const report = compileReport(labelled, [{ postal_input: 'SW1A 1AA' }, { postal_input: '12345' }], 200);
  assert.equal(report.holdout_validation.predictions, 30);
  assert.deepEqual(report.confusion_summary, [{ rule_id: 'GB_UK_FULL', predicted_country: 'GB', actual_country: 'CA', count: 1 }]);
  assert.equal(report.unknown_population_simulation.tier_a_classifiable, 0);
  assert.equal(report.unknown_population_simulation.tier_b_only, 1);
  assert.equal(report.unknown_population_simulation.unresolved, 1);
});

test('PII suppression rejects sensitive keys recursively', () => {
  for (const key of ['postcode', 'raw_json', 'name', 'email', 'phone', 'street', 'city', 'shipping_address']) assert.throws(() => assertSafeOutput({ [key]: 'secret' }), /Sensitive/);
  assert.doesNotThrow(() => assertSafeOutput({ country: 'GB', aggregate_count: 2 }));
});

test('queries are SELECT-only and runner never submits a write', async () => {
  const queries = buildQueries('project');
  for (const query of Object.values(queries)) assert.doesNotThrow(() => assertReadOnly(query));
  for (const sql of ['UPDATE x SET y=1', 'WITH x AS (SELECT 1) DELETE FROM x', 'CREATE TABLE x AS SELECT 1']) assert.throws(() => assertReadOnly(sql));
  const submitted = [];
  const bigquery = { query: async ({ query }) => { submitted.push(query); return [[]]; } };
  await runDiagnostic({ bigquery, project: 'project' });
  assert.equal(submitted.length, 2);
  assert.ok(submitted.every(query => /^\s*(?:SELECT|WITH)/i.test(query) && !/\b(?:INSERT|UPDATE|DELETE|CREATE|MERGE)\b/i.test(query)));
});

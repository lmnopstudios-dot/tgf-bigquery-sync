import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER_JOURNEY_TOOL_DEFINITION, validateJourneyDefinition } from '../oracle/customer-journey.js';
import { createOracleToolDefinitions } from '../oracle/tool-registry.js';
import { assertOracleToolSchemas, assertStrictJsonSchema } from '../oracle/tool-schema-validator.js';

const completeJourneyArguments = overrides => ({
  start_date: '2026-01-01', end_date: '2026-03-31',
  cohort_entry_start: '2026-01-01', cohort_entry_end: '2026-03-31', observation_end: '2026-06-29',
  first_order_semantic: 'first_observed_ever',
  cohort: {
    entity: 'customer', entry_event: 'purchase', entry_sequence: 'first_observed_order',
    entry_product_classification: 'collaboration', entry_product_ref: null, entry_channel: null,
    entry_source: null, entry_campaign: null, require_new_customer: true
  },
  subsequent: {
    event: 'purchase', after_entry: true, minimum_order_sequence: 2, maximum_order_sequence: 2,
    within_days: 90, product_classification: null, product_ref: null, channel: null, source: null
  },
  metrics: ['cohort_customers', 'downstream_product_sales'], group_by: ['downstream_product'],
  sort: 'sales_desc', limit: 20, ...overrides
});

test('analyze_customer_journey has an exact required/property set and nullable semantic options', () => {
  const parameters = CUSTOMER_JOURNEY_TOOL_DEFINITION.parameters;
  assert.deepEqual(new Set(parameters.required), new Set(Object.keys(parameters.properties)));
  for (const key of ['cohort_entry_start', 'cohort_entry_end', 'observation_end', 'first_order_semantic']) {
    assert.ok(parameters.required.includes(key));
    assert.ok(parameters.properties[key].type.includes('null'));
  }
  assertStrictJsonSchema(parameters);
});

test('strict validator rejects missing, unknown, duplicate, open, and nested object properties', () => {
  const child = { type: 'object', additionalProperties: false, properties: { value: { type: ['string', 'null'] } }, required: [] };
  const fixture = { type: 'object', additionalProperties: false, properties: { child }, required: ['child'] };
  assert.throws(() => assertStrictJsonSchema(fixture), /missing: value/);
  child.required = ['value', 'value'];
  assert.throws(() => assertStrictJsonSchema(fixture), /duplicate/);
  child.required = ['value', 'ghost'];
  assert.throws(() => assertStrictJsonSchema(fixture), /unknown: ghost/);
  child.required = ['value']; child.additionalProperties = true;
  assert.throws(() => assertStrictJsonSchema(fixture), /additionalProperties/);
});

test('the complete Oracle request-boundary registry passes before a non-journey request', () => {
  const request = { input: 'Give me monthly refunds', tools: createOracleToolDefinitions() };
  assert.equal(request.tools.find(tool => tool.name === 'analyze_customer_journey'), CUSTOMER_JOURNEY_TOOL_DEFINITION);
  assert.equal(assertOracleToolSchemas(request.tools), true);
});

test('representative collaboration, product-type, and follow-up journey arguments retain semantics', () => {
  const collaboration = validateJourneyDefinition(completeJourneyArguments());
  assert.equal(collaboration.first_order_semantic, 'first_observed_ever');
  assert.equal(collaboration.cohort.entry_product_classification, 'collaboration');
  assert.equal(collaboration.subsequent.maximum_order_sequence, 2);
  assert.equal(collaboration.subsequent.within_days, 90);
  const sunglasses = validateJourneyDefinition(completeJourneyArguments({ cohort: { ...completeJourneyArguments().cohort, entry_product_classification: 'sunglasses' } }));
  assert.equal(sunglasses.cohort.entry_product_classification, 'sunglasses');
});

test('nullable strict journey dates preserve legacy date fallback semantics', () => {
  const definition = validateJourneyDefinition(completeJourneyArguments({ cohort_entry_start: null, cohort_entry_end: null, observation_end: null, first_order_semantic: null }));
  assert.equal(definition.cohort_entry_start, definition.start_date);
  assert.equal(definition.cohort_entry_end, definition.end_date);
  assert.equal(definition.observation_end, definition.end_date);
  assert.equal(definition.first_order_semantic, 'first_observed_ever');
});

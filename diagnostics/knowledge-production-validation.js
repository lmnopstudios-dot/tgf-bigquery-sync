import { randomUUID } from 'node:crypto';
import { BigQuery } from '@google-cloud/bigquery';
import { createKnowledgeService, normalizeKnowledgeRows } from '../oracle/knowledge-bigquery.js';
import { redactError } from '../oracle/ui-security.js';
import { bigQueryDateParameters, describeDateParameter } from '../bigquery/date-parameters.js';

const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;
function validatedDateLiteral(value) {
  if (typeof value !== 'string' || !DATE_VALUE.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new Error('selected fixture returned an invalid DATE value');
  return `DATE '${value}'`;
}

export async function validateKnowledgeProduction({ bigquery, project, dataset = 'oracle_knowledge' }) {
  let queryDiagnostic = null;
  const service = createKnowledgeService({ bigquery, project, dataset, onDiagnostic: diagnostic => { queryDiagnostic = diagnostic; } });
  const evidence = {};
  const check = async (name, operation) => {
    queryDiagnostic = null;
    try { return await operation(); }
    catch (error) {
      error.validationContext = {
        validator: 'knowledge-production',
        check_name: name,
        operation: queryDiagnostic?.operation || 'validator_assertion',
        active_filter_names: queryDiagnostic?.active_filter_names || [],
        parameter_names: queryDiagnostic?.parameter_names || [],
        declared_parameter_types: queryDiagnostic?.declared_parameter_types || {},
        date_parameter_bindings: queryDiagnostic?.date_parameter_bindings || {},
        error_class: error?.name || error?.constructor?.name || 'Error',
        redacted_message: redactError(error?.message || 'Production knowledge validation failed').replace(/\s+/g, ' ').slice(0, 500)
      };
      throw error;
    }
  };
  const assertCheck = (condition, name, message, diagnosticEvidence = {}) => {
    if (condition) return;
    const error = new Error(message);
    error.validationContext = { validator: 'knowledge-production', check_name: name, operation: 'validator_assertion', active_filter_names: [], parameter_names: [], declared_parameter_types: {}, date_parameter_bindings: {}, evidence: diagnosticEvidence, error_class: 'Error', redacted_message: message };
    throw error;
  };

  const [schemaRows] = await check('persisted_temporal_schema', () => bigquery.query({
    query: `SELECT table_name, column_name, data_type FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\` WHERE (table_name='events' AND column_name IN ('event_id','status','start_date','end_date','date_precision')) OR (table_name IN ('facts','definitions','findings') AND column_name IN ('effective_from','effective_to')) ORDER BY table_name, column_name`,
    params: {}, types: {}, labels: { component: 'oracle_knowledge', operation: 'validate_schema' }
  }));
  evidence.schema = schemaRows;
  const expectedSchema = { event_id: 'STRING', status: 'STRING', start_date: 'DATE', end_date: 'DATE', date_precision: 'STRING' };
  const eventSchema = Object.fromEntries(schemaRows.filter(row => row.table_name === 'events').map(row => [row.column_name, row.data_type]));
  const temporalSchema = schemaRows.filter(row => row.table_name !== 'events');
  assertCheck(Object.entries(expectedSchema).every(([name, type]) => eventSchema[name] === type) && temporalSchema.length === 6 && temporalSchema.every(row => row.data_type === 'DATE'), 'persisted_temporal_schema', 'persisted knowledge schema does not match the physical contract', { columns: schemaRows.map(({ table_name, column_name, data_type }) => ({ table_name, column_name, data_type })) });

  evidence.unbounded = await check('unbounded_knowledge', () => service.searchKnowledge({ text: null, start_date: null, end_date: undefined, tags: [], limit: 50 }));
  assertCheck(evidence.unbounded.items.length, 'unbounded_knowledge', 'unbounded knowledge search returned no governed records');

  evidence.confirmed_events = await check('confirmed_event_fixture', () => service.searchKnowledge({ knowledge_type: 'event', status: 'confirmed', tags: [], limit: 50 }));
  const dated = evidence.confirmed_events.items.find(item => item.effective_from && item.effective_to);
  assertCheck(dated, 'confirmed_event_fixture', 'no current confirmed, fully dated knowledge item was available for temporal validation');
  evidence.exact = await check('exact_knowledge_retrieval', () => service.getKnowledgeItem({ knowledge_id: dated.id }));
  assertCheck(evidence.exact.found, 'exact_knowledge_retrieval', 'exact knowledge retrieval failed');
  const startDate = dated.effective_from;
  const endDate = dated.effective_to;
  const startDateLiteral = validatedDateLiteral(startDate);
  const endDateLiteral = validatedDateLiteral(endDate);
  const fixtureEvidence = { kind: dated.kind, id: dated.id, date_precision: dated.date_precision || null, has_effective_from: Boolean(dated.effective_from), has_effective_to: Boolean(dated.effective_to), bounded_start_date: startDate, bounded_end_date: endDate };
  const idParams = { id: dated.id };
  const idTypes = { id: 'STRING' };
  const [physicalRows] = await check('physical_event_by_id', () => bigquery.query({
    query: `SELECT event_id, status, start_date, end_date, date_precision FROM \`${project}.${dataset}.events\` WHERE event_id=@id`,
    params: idParams, types: idTypes, labels: { component: 'oracle_knowledge', operation: 'validate_physical_event' }
  }));
  const physical = normalizeKnowledgeRows(physicalRows)[0] || null;
  const physicalEvidence = physical && { event_id: physical.event_id, status: physical.status, start_date: physical.start_date, end_date: physical.end_date, date_precision: physical.date_precision };
  assertCheck(physicalRows.length === 1, 'physical_event_by_id', 'acceptance fixture was not uniquely present in the physical event table', { fixture: fixtureEvidence, returned_count: physicalRows.length, rows: normalizeKnowledgeRows(physicalRows).map(({ event_id, status, start_date, end_date, date_precision }) => ({ event_id, status, start_date, end_date, date_precision })), declared_parameter_types: idTypes });

  const dateParams = bigQueryDateParameters({ start_date: startDate, end_date: endDate });
  const rawParams = { id: dated.id, ...dateParams };
  const rawTypes = { id: 'STRING', start_date: 'DATE', end_date: 'DATE' };
  const parameterBindings = {
    start_date: describeDateParameter(dateParams.start_date, rawTypes.start_date),
    end_date: describeDateParameter(dateParams.end_date, rawTypes.end_date)
  };
  const predicates = [
    ['id_only', '', idParams, idTypes],
    ['id_status', " AND status='confirmed'", idParams, idTypes],
    ['literal_start_equality', ` AND start_date = ${startDateLiteral}`, idParams, idTypes],
    ['parameter_start_equality', ' AND start_date = @start_date', { id: dated.id, start_date: dateParams.start_date }, { id: 'STRING', start_date: 'DATE' }],
    ['literal_end_equality', ` AND end_date = ${endDateLiteral}`, idParams, idTypes],
    ['parameter_end_equality', ' AND end_date = @end_date', { id: dated.id, end_date: dateParams.end_date }, { id: 'STRING', end_date: 'DATE' }],
    ['literal_start_boundary', ` AND start_date <= ${endDateLiteral}`, idParams, idTypes],
    ['parameter_start_boundary', ' AND start_date <= @end_date', { id: dated.id, end_date: dateParams.end_date }, { id: 'STRING', end_date: 'DATE' }],
    ['literal_end_boundary', ` AND end_date >= ${startDateLiteral}`, idParams, idTypes],
    ['parameter_end_boundary', ' AND end_date >= @start_date', { id: dated.id, start_date: dateParams.start_date }, { id: 'STRING', start_date: 'DATE' }],
    ['id_temporal_overlap', ' AND start_date <= @end_date AND end_date >= @start_date', rawParams, rawTypes],
    ['id_status_temporal_overlap', " AND status='confirmed' AND start_date <= @end_date AND end_date >= @start_date", rawParams, rawTypes]
  ];
  const predicateMatrix = {};
  for (const [name, predicate, params, types] of predicates) {
    const [rows] = await check(`physical_predicate_${name}`, () => bigquery.query({ query: `SELECT event_id FROM \`${project}.${dataset}.events\` WHERE event_id=@id${predicate}`, params, types, labels: { component: 'oracle_knowledge', operation: 'validate_event_predicate' } }));
    predicateMatrix[name] = { matched: rows.length === 1, returned_count: rows.length };
  }
  assertCheck(Object.values(predicateMatrix).every(result => result.matched), 'direct_raw_bounded_sql', 'direct physical event predicate matrix rejected its acceptance fixture', { fixture: fixtureEvidence, physical_row: physicalEvidence, physical_schema: eventSchema, predicate_matrix: predicateMatrix, active_filter_names: ['id', 'status', 'start_date', 'end_date'], declared_parameter_types: rawTypes, date_parameter_bindings: parameterBindings });

  const boundedFilters = { knowledge_type: 'event', status: 'confirmed', start_date: startDate, end_date: endDate, tags: [], limit: 50 };
  evidence.bounded = await check('bounded_date_range', () => service.searchKnowledge(boundedFilters));
  const boundedEvidence = { fixture: fixtureEvidence, returned_count: evidence.bounded.returned_count, returned_ids: evidence.bounded.items.map(item => item.id), active_filter_names: ['statuses', 'knowledge_type', 'start_date', 'end_date', 'limit'], declared_parameter_types: { statuses: ['STRING'], knowledge_type: 'STRING', start_date: 'DATE', end_date: 'DATE', limit: 'INT64' }, date_parameter_bindings: parameterBindings };
  assertCheck(evidence.bounded.items.some(item => item.id === dated.id), 'bounded_date_range', 'bounded overlap search did not return its acceptance fixture', boundedEvidence);

  evidence.business_context = await check('business_context_retrieval', () => service.getBusinessContext({ start_date: startDate, end_date: endDate, topics: [] }));
  assertCheck(evidence.business_context.items.some(item => item.id === dated.id), 'business_context_retrieval', 'business-context retrieval did not return its acceptance fixture');

  evidence.empty_memory = await check('empty_memory_result', () => service.searchMemory({ text: `production-validator-no-match-${randomUUID()}`, start_date: null, end_date: null, tags: [], limit: 1 }));
  assertCheck(evidence.empty_memory.returned_count === 0, 'empty_memory_result', 'unique no-match memory search unexpectedly returned records');

  return {
    valid: true,
    checks: {
      unbounded_knowledge: evidence.unbounded.returned_count,
      persisted_temporal_schema: schemaRows.map(({ table_name, column_name, data_type }) => ({ table_name, column_name, data_type })),
      selected_fixture: fixtureEvidence,
      direct_exact_id_retrieval: evidence.exact.found,
      physical_event_row: physicalEvidence,
      physical_event_schema: eventSchema,
      physical_predicate_matrix: predicateMatrix,
      date_parameter_bindings: parameterBindings,
      literal_parameter_controls: Object.fromEntries(['literal_start_equality', 'parameter_start_equality', 'literal_end_equality', 'parameter_end_equality', 'literal_start_boundary', 'parameter_start_boundary', 'literal_end_boundary', 'parameter_end_boundary'].map(name => [name, predicateMatrix[name]])),
      direct_raw_bounded_sql: { returned_count: predicateMatrix.id_status_temporal_overlap.returned_count, returned_ids: predicateMatrix.id_status_temporal_overlap.matched ? [dated.id] : [], declared_parameter_types: rawTypes, date_parameter_bindings: parameterBindings },
      bounded_date_range: { ...boundedEvidence, start_date: startDate, end_date: endDate, fixture_id: dated.id },
      empty_arrays_and_null_omission: true,
      empty_memory_result: true,
      exact_knowledge_retrieval: evidence.exact.found,
      business_context_retrieval: evidence.business_context.returned_count
    }
  };
}

async function main() {
  const project = process.env.GOOGLE_PROJECT_ID || 'gf-full-data';
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const bigquery = new BigQuery({ projectId: project, credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) });
  console.log(JSON.stringify(await validateKnowledgeProduction({ bigquery, project, dataset: process.env.KNOWLEDGE_DATASET || 'oracle_knowledge' }), null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(error => {
  console.error(JSON.stringify({ validation_failed: true, ...(error.validationContext || { validator: 'knowledge-production', check_name: 'initialization', operation: 'validator_initialization', active_filter_names: [], parameter_names: [], declared_parameter_types: {}, date_parameter_bindings: {}, error_class: error?.name || 'Error', redacted_message: redactError(error?.message || 'Production knowledge validation failed').slice(0, 500) }) }));
  process.exitCode = 1;
});

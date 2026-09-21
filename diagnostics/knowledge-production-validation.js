import { randomUUID } from 'node:crypto';
import { BigQuery } from '@google-cloud/bigquery';
import { createKnowledgeService } from '../oracle/knowledge-bigquery.js';
import { redactError } from '../oracle/ui-security.js';

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
        parameter_types: queryDiagnostic?.parameter_types || {},
        error_class: error?.name || error?.constructor?.name || 'Error',
        redacted_message: redactError(error?.message || 'Production knowledge validation failed').replace(/\s+/g, ' ').slice(0, 500)
      };
      throw error;
    }
  };
  const assertCheck = (condition, name, message, diagnosticEvidence = {}) => {
    if (condition) return;
    const error = new Error(message);
    error.validationContext = { validator: 'knowledge-production', check_name: name, operation: 'validator_assertion', active_filter_names: [], parameter_names: [], parameter_types: {}, evidence: diagnosticEvidence, error_class: 'Error', redacted_message: message };
    throw error;
  };

  const [schemaRows] = await check('persisted_temporal_schema', () => bigquery.query({
    query: `SELECT table_name, column_name, data_type FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\` WHERE (table_name='events' AND column_name IN ('start_date','end_date')) OR (table_name IN ('facts','definitions','findings') AND column_name IN ('effective_from','effective_to')) ORDER BY table_name, column_name`,
    params: {}, types: {}, labels: { component: 'oracle_knowledge', operation: 'validate_schema' }
  }));
  evidence.schema = schemaRows;
  const expectedSchemaCount = 8;
  assertCheck(schemaRows.length === expectedSchemaCount && schemaRows.every(row => row.data_type === 'DATE'), 'persisted_temporal_schema', 'persisted temporal columns are not all DATE', { returned_column_count: schemaRows.length, columns: schemaRows.map(({ table_name, column_name, data_type }) => ({ table_name, column_name, data_type })) });

  evidence.unbounded = await check('unbounded_knowledge', () => service.searchKnowledge({ text: null, start_date: null, end_date: undefined, tags: [], limit: 50 }));
  assertCheck(evidence.unbounded.items.length, 'unbounded_knowledge', 'unbounded knowledge search returned no governed records');

  evidence.confirmed_events = await check('confirmed_event_fixture', () => service.searchKnowledge({ knowledge_type: 'event', status: 'confirmed', tags: [], limit: 50 }));
  const dated = evidence.confirmed_events.items.find(item => item.effective_from && item.effective_to);
  assertCheck(dated, 'confirmed_event_fixture', 'no current confirmed, fully dated knowledge item was available for temporal validation');
  evidence.exact = await check('exact_knowledge_retrieval', () => service.getKnowledgeItem({ knowledge_id: dated.id }));
  assertCheck(evidence.exact.found, 'exact_knowledge_retrieval', 'exact knowledge retrieval failed');
  const startDate = dated.effective_from;
  const endDate = dated.effective_to;
  const fixtureEvidence = { kind: dated.kind, id: dated.id, date_precision: dated.date_precision || null, has_effective_from: Boolean(dated.effective_from), has_effective_to: Boolean(dated.effective_to), bounded_start_date: startDate, bounded_end_date: endDate };
  const rawParams = { id: dated.id, start_date: startDate, end_date: endDate };
  const rawTypes = { id: 'STRING', start_date: 'DATE', end_date: 'DATE' };
  const [rawRows] = await check('direct_raw_bounded_sql', () => bigquery.query({
    query: `SELECT event_id id FROM \`${project}.${dataset}.events\` WHERE event_id=@id AND status='confirmed' AND COALESCE(start_date, DATE '0001-01-01') <= @end_date AND COALESCE(end_date, DATE '9999-12-31') >= @start_date`,
    params: rawParams, types: rawTypes, labels: { component: 'oracle_knowledge', operation: 'validate_raw_overlap' }
  }));
  assertCheck(rawRows.some(row => row.id === dated.id), 'direct_raw_bounded_sql', 'direct raw bounded SQL did not return its acceptance fixture', { fixture: fixtureEvidence, returned_count: rawRows.length, returned_ids: rawRows.map(row => row.id), active_filter_names: ['id', 'status', 'start_date', 'end_date'], parameter_types: rawTypes });

  const boundedFilters = { knowledge_type: 'event', status: 'confirmed', start_date: startDate, end_date: endDate, tags: [], limit: 50 };
  evidence.bounded = await check('bounded_date_range', () => service.searchKnowledge(boundedFilters));
  const boundedEvidence = { fixture: fixtureEvidence, returned_count: evidence.bounded.returned_count, returned_ids: evidence.bounded.items.map(item => item.id), active_filter_names: ['statuses', 'knowledge_type', 'start_date', 'end_date', 'limit'], parameter_types: { statuses: ['STRING'], knowledge_type: 'STRING', start_date: 'DATE', end_date: 'DATE', limit: 'INT64' } };
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
      direct_raw_bounded_sql: { returned_count: rawRows.length, returned_ids: rawRows.map(row => row.id), parameter_types: rawTypes },
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
  console.error(JSON.stringify({ validation_failed: true, ...(error.validationContext || { validator: 'knowledge-production', check_name: 'initialization', operation: 'validator_initialization', active_filter_names: [], parameter_names: [], parameter_types: {}, error_class: error?.name || 'Error', redacted_message: redactError(error?.message || 'Production knowledge validation failed').slice(0, 500) }) }));
  process.exitCode = 1;
});

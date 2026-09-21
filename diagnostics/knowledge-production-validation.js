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
  const assertCheck = (condition, name, message) => {
    if (condition) return;
    const error = new Error(message);
    error.validationContext = { validator: 'knowledge-production', check_name: name, operation: 'validator_assertion', active_filter_names: [], parameter_names: [], parameter_types: {}, error_class: 'Error', redacted_message: message };
    throw error;
  };

  evidence.unbounded = await check('unbounded_knowledge', () => service.searchKnowledge({ text: null, start_date: null, end_date: undefined, tags: [], limit: 50 }));
  assertCheck(evidence.unbounded.items.length, 'unbounded_knowledge', 'unbounded knowledge search returned no governed records');

  evidence.confirmed_events = await check('confirmed_event_fixture', () => service.searchKnowledge({ knowledge_type: 'event', status: 'confirmed', tags: [], limit: 50 }));
  const dated = evidence.confirmed_events.items.find(item => item.effective_from && item.effective_to);
  assertCheck(dated, 'confirmed_event_fixture', 'no current confirmed, fully dated knowledge item was available for temporal validation');
  const startDate = typeof dated.effective_from === 'object' ? dated.effective_from.value : dated.effective_from;
  const endDate = typeof dated.effective_to === 'object' ? dated.effective_to.value : dated.effective_to;
  evidence.bounded = await check('bounded_date_range', () => service.searchKnowledge({ start_date: startDate, end_date: endDate, tags: [], limit: 50 }));
  assertCheck(evidence.bounded.items.some(item => item.id === dated.id), 'bounded_date_range', 'bounded overlap search did not return its acceptance fixture');

  evidence.exact = await check('exact_knowledge_retrieval', () => service.getKnowledgeItem({ knowledge_id: dated.id }));
  assertCheck(evidence.exact.found, 'exact_knowledge_retrieval', 'exact knowledge retrieval failed');
  evidence.business_context = await check('business_context_retrieval', () => service.getBusinessContext({ start_date: startDate, end_date: endDate, topics: [] }));
  assertCheck(evidence.business_context.items.some(item => item.id === dated.id), 'business_context_retrieval', 'business-context retrieval did not return its acceptance fixture');

  evidence.empty_memory = await check('empty_memory_result', () => service.searchMemory({ text: `production-validator-no-match-${randomUUID()}`, start_date: null, end_date: null, tags: [], limit: 1 }));
  assertCheck(evidence.empty_memory.returned_count === 0, 'empty_memory_result', 'unique no-match memory search unexpectedly returned records');

  return {
    valid: true,
    checks: {
      unbounded_knowledge: evidence.unbounded.returned_count,
      bounded_date_range: { start_date: startDate, end_date: endDate, fixture_id: dated.id },
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

import { randomUUID } from 'node:crypto';
import { BigQuery } from '@google-cloud/bigquery';
import { createKnowledgeService } from '../oracle/knowledge-bigquery.js';
import { redactError } from '../oracle/ui-security.js';

export async function validateKnowledgeProduction({ bigquery, project, dataset = 'oracle_knowledge' }) {
  const service = createKnowledgeService({ bigquery, project, dataset });
  const evidence = {};

  evidence.unbounded = await service.searchKnowledge({ text: null, start_date: null, end_date: undefined, tags: [], limit: 50 });
  if (!evidence.unbounded.items.length) throw new Error('unbounded knowledge search returned no governed records');

  evidence.confirmed_events = await service.searchKnowledge({ knowledge_type: 'event', status: 'confirmed', tags: [], limit: 50 });
  const dated = evidence.confirmed_events.items.find(item => item.effective_from && item.effective_to);
  if (!dated) throw new Error('no current confirmed, fully dated knowledge item was available for temporal validation');
  evidence.bounded = await service.searchKnowledge({ start_date: dated.effective_from, end_date: dated.effective_to, tags: [], limit: 50 });
  if (!evidence.bounded.items.some(item => item.id === dated.id)) throw new Error('bounded overlap search did not return its acceptance fixture');

  evidence.exact = await service.getKnowledgeItem({ knowledge_id: dated.id });
  if (!evidence.exact.found) throw new Error('exact knowledge retrieval failed');
  evidence.business_context = await service.getBusinessContext({ start_date: dated.effective_from, end_date: dated.effective_to, topics: [] });
  if (!evidence.business_context.items.some(item => item.id === dated.id)) throw new Error('business-context retrieval did not return its acceptance fixture');

  evidence.empty_memory = await service.searchMemory({ text: `production-validator-no-match-${randomUUID()}`, start_date: null, end_date: null, tags: [], limit: 1 });
  if (evidence.empty_memory.returned_count !== 0) throw new Error('unique no-match memory search unexpectedly returned records');

  return {
    valid: true,
    checks: {
      unbounded_knowledge: evidence.unbounded.returned_count,
      bounded_date_range: { start_date: dated.effective_from, end_date: dated.effective_to, fixture_id: dated.id },
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
  console.error(JSON.stringify({ validation_failed: true, error_class: error?.name || 'Error', message: redactError(error?.message || 'Production knowledge validation failed').slice(0, 500) }));
  process.exitCode = 1;
});

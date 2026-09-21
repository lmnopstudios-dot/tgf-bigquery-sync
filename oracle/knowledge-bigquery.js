import { MAX_RETRIEVAL_LIMIT } from './knowledge.js';
import { redactError } from './ui-security.js';
import { bigQueryDateParameters, describeDateParameter } from '../bigquery/date-parameters.js';

function normalizeValue(value) {
  if (value == null) return value;
  // BigQuery DATE values are returned as BigQueryDate instances whose JSON shape
  // is { value: "YYYY-MM-DD" }.  Keep the service boundary independent of the
  // client library representation without changing arbitrary JSON objects.
  if (value?.constructor?.name === 'BigQueryDate' && typeof value.value === 'string') return value.value;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeValue(child)]));
  return value;
}
export const normalizeKnowledgeRows = rows => rows.map(row => normalizeValue(row));
const present = value => value !== null && value !== undefined;
const nonEmptyText = value => present(value) && String(value).trim() !== '';
const nonEmptyArray = value => Array.isArray(value) && value.length > 0;

function dates(input) {
  if ((nonEmptyText(input.start_date) && !nonEmptyText(input.end_date)) || (!nonEmptyText(input.start_date) && nonEmptyText(input.end_date))) throw new Error('start_date and end_date must be supplied together');
  if (nonEmptyText(input.start_date) && input.start_date > input.end_date) throw new Error('start_date must be on or before end_date');
}
function limit(value) { if (!Number.isInteger(value) || value < 1 || value > MAX_RETRIEVAL_LIMIT) throw new Error('limit must be between 1 and 50'); return value; }
function diagnosticError(error) {
  return {
    error_class: error?.name || error?.constructor?.name || 'Error',
    redacted_message: redactError(error?.message || 'BigQuery query failed').replace(/\s+/g, ' ').slice(0, 500)
  };
}

export function createKnowledgeService({ bigquery, project, dataset = 'oracle_knowledge', onDiagnostic = () => {} }) {
  if (!bigquery?.query || !project) throw new Error('bigquery and project are required');
  const table = name => `\`${project}.${dataset}.${name}\``;
  async function query(operation, sql, params = {}, types = {}, context = {}) {
    const dateParameterBindings = Object.fromEntries(Object.entries(types)
      .filter(([, type]) => type === 'DATE')
      .map(([name, type]) => [name, describeDateParameter(params[name], type)]));
    const diagnostic = { operation, active_filter_names: context.activeFilters || [], parameter_names: Object.keys(params), declared_parameter_types: types, date_parameter_bindings: dateParameterBindings };
    try {
      const [rows] = await bigquery.query({ query: sql, params, types, labels: { component: 'oracle_knowledge', operation } });
      return normalizeKnowledgeRows(rows);
    } catch (error) {
      onDiagnostic({ ...diagnostic, phase: 'error', ...diagnosticError(error) });
      throw error;
    }
  }
  async function searchKnowledge(input = {}) {
    const f = { ...input };
    const resultLimit = present(f.limit) ? f.limit : 20;
    dates(f); limit(resultLimit);
    const predicates = [];
    const params = {}; const types = {};
    const activeFilters = [];
    const add = (name, predicate, value, type) => { predicates.push(predicate); params[name] = value; types[name] = type; activeFilters.push(name); };
    add('statuses', 'status IN UNNEST(@statuses)', nonEmptyText(f.status) ? [f.status] : ['confirmed', 'working'], ['STRING']);
    if (nonEmptyText(f.knowledge_type)) add('knowledge_type', 'kind = @knowledge_type', f.knowledge_type, 'STRING');
    if (nonEmptyText(f.text)) add('text', "LOWER(CONCAT(title,' ',content)) LIKE CONCAT('%',LOWER(@text),'%')", f.text, 'STRING');
    if (nonEmptyArray(f.tags)) add('tags', 'EXISTS(SELECT 1 FROM UNNEST(tags) t WHERE LOWER(t) IN (SELECT LOWER(x) FROM UNNEST(@tags) x))', f.tags, ['STRING']);
    if (nonEmptyText(f.start_date)) {
      predicates.push("COALESCE(effective_from, DATE '0001-01-01') <= @end_date AND COALESCE(effective_to, DATE '9999-12-31') >= @start_date");
      Object.assign(params, bigQueryDateParameters({ start_date: f.start_date, end_date: f.end_date })); activeFilters.push('start_date', 'end_date');
      types.start_date = 'DATE'; types.end_date = 'DATE';
    }
    params.limit = resultLimit; types.limit = 'INT64'; activeFilters.push('limit');
    const temporalOrder = nonEmptyText(f.start_date) ? 'CASE WHEN effective_from IS NOT NULL OR effective_to IS NOT NULL THEN 0 ELSE 1 END,' : '';
    const rows = await query('search_knowledge', `SELECT * FROM (
      SELECT 'fact' kind, knowledge_id id, subject title, statement content, effective_from, effective_to, CAST(NULL AS STRING) date_precision, status, tags, source_type, source_reference, recorded_at FROM ${table('facts')}
      UNION ALL SELECT 'event', event_id, title, description, start_date, end_date, date_precision, status, tags, source_type, source_reference, recorded_at FROM ${table('events')}
      UNION ALL SELECT 'definition', definition_id, term, definition, effective_from, effective_to, CAST(NULL AS STRING) date_precision, status, tags, source_type, source_reference, recorded_at FROM ${table('definitions')})
      WHERE ${predicates.join(' AND ')}
      ORDER BY ${temporalOrder} CASE kind WHEN 'definition' THEN 0 ELSE 1 END, CASE status WHEN 'confirmed' THEN 0 WHEN 'working' THEN 1 ELSE 2 END, recorded_at DESC LIMIT @limit`, params, types, { activeFilters });
    return { items: rows, returned_count: rows.length, limit: resultLimit };
  }
  async function getBusinessContext({ start_date, end_date, topics = [] }) {
    const result = await searchKnowledge({ start_date, end_date, status: 'confirmed', tags: topics, limit: 50 });
    return { ...result, start_date, end_date, topics, semantics: 'Structured confirmed context overlapping the period; unknown-date facts/definitions remain eligible. Nearby non-overlapping events are not asserted active.' };
  }
  async function getKnowledgeItem({ knowledge_id }) {
    if (!/^(kn|ev|df)_/.test(knowledge_id)) throw new Error('invalid knowledge_id');
    const map = { kn: 'facts', ev: 'events', df: 'definitions' }; const idField = { kn: 'knowledge_id', ev: 'event_id', df: 'definition_id' }; const p = knowledge_id.slice(0, 2);
    const rows = await query('get_knowledge_item', `SELECT * FROM ${table(map[p])} WHERE ${idField[p]}=@id LIMIT 1`, { id: knowledge_id }, { id: 'STRING' }, { activeFilters: ['id'] });
    return { found: rows.length === 1, item: rows[0] || null };
  }
  async function searchMemory(input = {}) {
    const f = { ...input }; const resultLimit = present(f.limit) ? f.limit : 20;
    dates(f); limit(resultLimit);
    const predicates = []; const params = {}; const types = {}; const activeFilters = [];
    const add = (name, predicate, value, type) => { predicates.push(predicate); params[name] = value; types[name] = type; activeFilters.push(name); };
    add('statuses', 'status IN UNNEST(@statuses)', nonEmptyText(f.status) ? [f.status] : ['confirmed', 'working'], ['STRING']);
    if (nonEmptyText(f.memory_type)) add('memory_type', 'memory_type = @memory_type', f.memory_type, 'STRING');
    if (nonEmptyText(f.text)) add('text', "LOWER(CONCAT(title,' ',statement)) LIKE CONCAT('%',LOWER(@text),'%')", f.text, 'STRING');
    if (nonEmptyArray(f.tags)) add('tags', 'EXISTS(SELECT 1 FROM UNNEST(tags) t WHERE LOWER(t) IN (SELECT LOWER(x) FROM UNNEST(@tags) x))', f.tags, ['STRING']);
    if (nonEmptyText(f.start_date)) {
      predicates.push("COALESCE(effective_from,DATE '0001-01-01') <= @end_date AND COALESCE(effective_to,DATE '9999-12-31') >= @start_date");
      Object.assign(params, bigQueryDateParameters({ start_date: f.start_date, end_date: f.end_date })); activeFilters.push('start_date', 'end_date');
      types.start_date = 'DATE'; types.end_date = 'DATE';
    }
    params.limit = resultLimit; types.limit = 'INT64'; activeFilters.push('limit');
    const rows = await query('search_memory', `SELECT memory_id id, 'memory' kind, title, statement content, memory_type, status, effective_from, effective_to, evidence, source_type, source_reference, tags, created_at FROM ${table('findings')} WHERE ${predicates.join(' AND ')} ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'working' THEN 1 ELSE 2 END, created_at DESC LIMIT @limit`, params, types, { activeFilters });
    return { items: rows, returned_count: rows.length, limit: resultLimit, warning: 'Memory is context, not a numerical cache. Live governed quantitative data remains authoritative.' };
  }
  async function getMemoryItem({ memory_id }) { if (!/^mem_/.test(memory_id)) throw new Error('invalid memory_id'); const rows = await query('get_memory_item', `SELECT * FROM ${table('findings')} WHERE memory_id=@id LIMIT 1`, { id: memory_id }, { id: 'STRING' }, { activeFilters: ['id'] }); return { found: rows.length === 1, item: rows[0] || null }; }
  return { searchKnowledge, getBusinessContext, getKnowledgeItem, searchMemory, getMemoryItem };
}

export async function executeKnowledgeToolCall(service, name, args, onDiagnostic = () => {}) {
  const methods = { search_knowledge: 'searchKnowledge', get_business_context: 'getBusinessContext', get_knowledge_item: 'getKnowledgeItem', search_memory: 'searchMemory', get_memory_item: 'getMemoryItem' };
  if (!methods[name]) return { handled: false, result: null };
  const activeFilters = Object.entries(args || {}).filter(([, value]) => present(value) && (!Array.isArray(value) || value.length)).map(([key]) => key);
  onDiagnostic({ operation: name, phase: 'start', active_filter_names: activeFilters, parameter_names: activeFilters });
  try { return { handled: true, result: await service[methods[name]](args || {}) }; }
  catch (error) { onDiagnostic({ operation: name, phase: 'error', active_filter_names: activeFilters, parameter_names: activeFilters, ...diagnosticError(error) }); throw error; }
}

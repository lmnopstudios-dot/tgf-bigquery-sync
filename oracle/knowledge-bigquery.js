import { MAX_RETRIEVAL_LIMIT } from './knowledge.js';

const clean = rows => rows.map(row => JSON.parse(JSON.stringify(row)));
function dates(input) {
  if ((input.start_date && !input.end_date) || (!input.start_date && input.end_date)) throw new Error('start_date and end_date must be supplied together');
  if (input.start_date && input.start_date > input.end_date) throw new Error('start_date must be on or before end_date');
}
function limit(value) { if (!Number.isInteger(value) || value < 1 || value > MAX_RETRIEVAL_LIMIT) throw new Error('limit must be between 1 and 50'); return value; }

export function createKnowledgeService({ bigquery, project, dataset = 'oracle_knowledge' }) {
  if (!bigquery?.query || !project) throw new Error('bigquery and project are required');
  const table = name => `\`${project}.${dataset}.${name}\``;
  async function query(operation, sql, params = {}, types) {
    const [rows] = await bigquery.query({ query: sql, params, ...(types && { types }), labels:{component:'oracle_knowledge',operation} }); return clean(rows);
  }
  async function searchKnowledge(input) {
    const f = {text:null,knowledge_type:null,start_date:null,end_date:null,status:null,tags:[],limit:20,...input}; dates(f); limit(f.limit);
    const statuses = f.status ? [f.status] : ['confirmed','working'];
    const rows = await query('search_knowledge', `SELECT * FROM (
      SELECT 'fact' kind, knowledge_id id, subject title, statement content, effective_from, effective_to, status, tags, source_type, source_reference, recorded_at FROM ${table('facts')}
      UNION ALL SELECT 'event', event_id, title, description, start_date, end_date, status, tags, source_type, source_reference, recorded_at FROM ${table('events')}
      UNION ALL SELECT 'definition', definition_id, term, definition, effective_from, effective_to, status, tags, source_type, source_reference, recorded_at FROM ${table('definitions')})
      WHERE (@knowledge_type IS NULL OR kind=@knowledge_type) AND status IN UNNEST(@statuses)
      AND (@text IS NULL OR LOWER(CONCAT(title,' ',content)) LIKE CONCAT('%',LOWER(@text),'%'))
      AND (ARRAY_LENGTH(@tags)=0 OR EXISTS(SELECT 1 FROM UNNEST(tags) t WHERE LOWER(t) IN (SELECT LOWER(x) FROM UNNEST(@tags) x)))
      AND (@start_date IS NULL OR (COALESCE(effective_from, DATE '0001-01-01') <= DATE(@end_date) AND COALESCE(effective_to, DATE '9999-12-31') >= DATE(@start_date)))
      ORDER BY CASE kind WHEN 'definition' THEN 0 ELSE 1 END, CASE status WHEN 'confirmed' THEN 0 WHEN 'working' THEN 1 ELSE 2 END, recorded_at DESC LIMIT @limit`, {...f,statuses},{knowledge_type:'STRING',text:'STRING',start_date:'STRING',end_date:'STRING'});
    return {items:rows,returned_count:rows.length,limit:f.limit};
  }
  async function getBusinessContext({start_date,end_date,topics=[]}) { const result=await searchKnowledge({text:null,knowledge_type:null,start_date,end_date,status:'confirmed',tags:topics,limit:50}); return {...result,start_date,end_date,topics,semantics:'Structured confirmed context overlapping the period; unknown-date facts/definitions remain eligible. Nearby non-overlapping events are not asserted active.'}; }
  async function getKnowledgeItem({knowledge_id}) { if (!/^(kn|ev|df)_/.test(knowledge_id)) throw new Error('invalid knowledge_id'); const map={kn:'facts',ev:'events',df:'definitions'}; const idField={kn:'knowledge_id',ev:'event_id',df:'definition_id'}; const p=knowledge_id.slice(0,2); const rows=await query('get_knowledge_item',`SELECT * FROM ${table(map[p])} WHERE ${idField[p]}=@id LIMIT 1`,{id:knowledge_id}); return {found:rows.length===1,item:rows[0]||null}; }
  async function searchMemory(input) { const f={text:null,start_date:null,end_date:null,status:null,memory_type:null,tags:[],limit:20,...input}; dates(f); limit(f.limit); const statuses=f.status?[f.status]:['confirmed','working']; const rows=await query('search_memory',`SELECT memory_id id, 'memory' kind, title, statement content, memory_type, status, effective_from, effective_to, evidence, source_type, source_reference, tags, created_at FROM ${table('findings')} WHERE status IN UNNEST(@statuses) AND (@memory_type IS NULL OR memory_type=@memory_type) AND (@text IS NULL OR LOWER(CONCAT(title,' ',statement)) LIKE CONCAT('%',LOWER(@text),'%')) AND (ARRAY_LENGTH(@tags)=0 OR EXISTS(SELECT 1 FROM UNNEST(tags) t WHERE LOWER(t) IN (SELECT LOWER(x) FROM UNNEST(@tags) x))) AND (@start_date IS NULL OR (COALESCE(effective_from,DATE '0001-01-01')<=DATE(@end_date) AND COALESCE(effective_to,DATE '9999-12-31')>=DATE(@start_date))) ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'working' THEN 1 ELSE 2 END, created_at DESC LIMIT @limit`,{...f,statuses},{text:'STRING',start_date:'STRING',end_date:'STRING',memory_type:'STRING'}); return {items:rows,returned_count:rows.length,limit:f.limit,warning:'Memory is context, not a numerical cache. Live governed quantitative data remains authoritative.'}; }
  async function getMemoryItem({memory_id}) { if (!/^mem_/.test(memory_id)) throw new Error('invalid memory_id'); const rows=await query('get_memory_item',`SELECT * FROM ${table('findings')} WHERE memory_id=@id LIMIT 1`,{id:memory_id}); return {found:rows.length===1,item:rows[0]||null}; }
  return {searchKnowledge,getBusinessContext,getKnowledgeItem,searchMemory,getMemoryItem};
}

export async function executeKnowledgeToolCall(service,name,args,onDiagnostic=()=>{}) { const methods={search_knowledge:'searchKnowledge',get_business_context:'getBusinessContext',get_knowledge_item:'getKnowledgeItem',search_memory:'searchMemory',get_memory_item:'getMemoryItem'}; if(!methods[name]) return {handled:false,result:null}; onDiagnostic({tool:name,id:args.knowledge_id||args.memory_id||null,start_date:args.start_date||null,end_date:args.end_date||null}); return {handled:true,result:await service[methods[name]](args)}; }

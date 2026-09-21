import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { BigQuery } from '@google-cloud/bigquery';
import { validateKnowledgeItem, validateMemory } from '../oracle/knowledge.js';

const seeds = JSON.parse(readFileSync(new URL('./seeds.json', import.meta.url), 'utf8'));

export const DATASET = 'oracle_knowledge';
const TABLE_SCHEMAS = {
  facts: ['knowledge_id:STRING','subject:STRING','predicate:STRING','statement:STRING','effective_from:DATE','effective_to:DATE','recorded_at:TIMESTAMP','source_type:STRING','source_reference:STRING','status:STRING','created_by:STRING','supersedes:STRING','superseded_by:STRING','tags:STRING:REPEATED'],
  events: ['event_id:STRING','event_type:STRING','title:STRING','description:STRING','start_date:DATE','end_date:DATE','date_precision:STRING','recorded_at:TIMESTAMP','source_type:STRING','source_reference:STRING','status:STRING','created_by:STRING','supersedes:STRING','superseded_by:STRING','tags:STRING:REPEATED'],
  definitions: ['definition_id:STRING','term:STRING','definition:STRING','implementation_reference:STRING','effective_from:DATE','effective_to:DATE','recorded_at:TIMESTAMP','source_type:STRING','source_reference:STRING','status:STRING','created_by:STRING','supersedes:STRING','superseded_by:STRING','tags:STRING:REPEATED'],
  findings: ['memory_id:STRING','title:STRING','statement:STRING','memory_type:STRING','status:STRING','created_at:TIMESTAMP','effective_from:DATE','effective_to:DATE','evidence:JSON','source_type:STRING','source_reference:STRING','created_by:STRING','supersedes:STRING','superseded_by:STRING','confidence:FLOAT','tags:STRING:REPEATED']
};
export function bqClient(env=process.env) { const credentials=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON); return new BigQuery({projectId:env.GOOGLE_PROJECT_ID||'gf-full-data',credentials}); }
export async function setup(client, project, datasetName=DATASET) {
  const dataset=client.dataset(datasetName); const [exists]=await dataset.exists(); if(!exists) await dataset.create({location:'EU',labels:{component:'oracle_knowledge'}});
  for(const [name,fields] of Object.entries(TABLE_SCHEMAS)){const table=dataset.table(name);const [found]=await table.exists();if(!found)await table.create({schema:{fields:fields.map(spec=>{const [n,type,mode]=spec.split(':');return {name:n,type,mode:mode||'NULLABLE'};})},timePartitioning:{type:'DAY',field:name==='findings'?'created_at':'recorded_at'},labels:{component:'oracle_knowledge'}});}
  return {dataset:`${project}.${datasetName}`,tables:Object.keys(TABLE_SCHEMAS)};
}
function row(kind,item,now=new Date().toISOString()){const common={source_type:item.source_type,source_reference:item.source_reference,status:item.status,created_by:item.created_by,supersedes:item.supersedes,superseded_by:null,tags:item.tags};if(kind==='fact')return {knowledge_id:item.id,subject:item.subject,predicate:item.predicate,statement:item.statement,effective_from:item.effective_from,effective_to:item.effective_to,recorded_at:now,...common};if(kind==='event')return {event_id:item.id,event_type:item.event_type,title:item.title,description:item.description,start_date:item.effective_from,end_date:item.effective_to,date_precision:item.date_precision,recorded_at:now,...common};if(kind==='definition')return {definition_id:item.id,term:item.term,definition:item.definition,implementation_reference:item.implementation_reference,effective_from:item.effective_from,effective_to:item.effective_to,recorded_at:now,...common};return {memory_id:item.id,title:item.title,statement:item.statement,memory_type:item.memory_type,status:item.status,created_at:now,effective_from:item.effective_from,effective_to:item.effective_to,evidence:JSON.stringify(item.evidence),source_type:item.source_type,source_reference:item.source_reference,created_by:item.created_by,supersedes:item.supersedes,superseded_by:null,confidence:item.confidence??null,tags:item.tags};}
export async function writeRecord(client,project,input,datasetName=DATASET){const kind=input.kind;const item=kind==='memory'?validateMemory(input):validateKnowledgeItem(kind,input);const table={fact:'facts',event:'events',definition:'definitions',memory:'findings'}[kind];const idField={fact:'knowledge_id',event:'event_id',definition:'definition_id',memory:'memory_id'}[kind];if(item.supersedes){const [prior]=await client.query({query:`SELECT status FROM \`${project}.${datasetName}.${table}\` WHERE ${idField}=@id`,params:{id:item.supersedes}});if(prior.length!==1)throw new Error('supersedes target not found');}
  await client.dataset(datasetName).table(table).insert([row(kind,item)]);
  if(item.supersedes)await client.query({query:`UPDATE \`${project}.${datasetName}.${table}\` SET status='superseded', superseded_by=@new_id WHERE ${idField}=@old_id AND status!='superseded'`,params:{new_id:item.id,old_id:item.supersedes}});
  return {kind,id:item.id,table:`${project}.${datasetName}.${table}`,supersedes:item.supersedes};}
export async function readInput(path){return JSON.parse(await fs.readFile(path,'utf8'));}
export { seeds };

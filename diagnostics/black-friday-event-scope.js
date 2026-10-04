import {BigQuery} from '@google-cloud/bigquery';
import {createKnowledgeService} from '../oracle/knowledge-bigquery.js';
import {resolveHistoricalEvents} from '../oracle/historical-event-comparison.js';

const project=process.env.GOOGLE_PROJECT_ID||process.env.GCLOUD_PROJECT;
if(!project)throw new Error('GOOGLE_PROJECT_ID or GCLOUD_PROJECT is required');
const asOf=process.argv.find(x=>x.startsWith('--as-of='))?.slice(8)||new Date().toISOString().slice(0,10);
if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf))throw new Error('--as-of must be YYYY-MM-DD');
const service=createKnowledgeService({bigquery:new BigQuery({projectId:project}),project,dataset:process.env.ORACLE_KNOWLEDGE_DATASET||'oracle_knowledge'});
const result=await service.searchKnowledge({text:null,knowledge_type:'event',start_date:null,end_date:null,status:'confirmed',tags:['black-friday'],limit:50});
const resolved=resolveHistoricalEvents(result.items,{asOf,count:3});
console.log(JSON.stringify({contract:'read_only_aggregate_no_pii',as_of:asOf,returned_records:result.returned_count,resolved_events:resolved.events.map(({id,name,year,start_date,end_date,duration_days,timezone,provenance})=>({id,name,year,start_date,end_date,duration_days,timezone,provenance})),conflicts:resolved.conflicts,invalid:resolved.invalid,complete:resolved.complete},null,2));
if(!resolved.complete)process.exitCode=2;

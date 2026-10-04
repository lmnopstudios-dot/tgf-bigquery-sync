import {createBigQueryClient} from '../bigquery/client.js';
import {createKnowledgeService} from '../oracle/knowledge-bigquery.js';
import {resolveHistoricalEvents} from '../oracle/historical-event-comparison.js';

export async function main({env=process.env,argv=process.argv.slice(2),BigQueryClass,write=value=>process.stdout.write(value)}={}){
  const {project,bigquery}=createBigQueryClient(env,BigQueryClass);
  const asOf=argv.find(x=>x.startsWith('--as-of='))?.slice(8)||new Date().toISOString().slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf))throw new Error('--as-of must be YYYY-MM-DD');
  const service=createKnowledgeService({bigquery,project,dataset:env.ORACLE_KNOWLEDGE_DATASET||'oracle_knowledge'});
  const result=await service.searchKnowledge({text:null,knowledge_type:'event',start_date:null,end_date:null,status:null,tags:['black-friday'],limit:50});
  const resolved=resolveHistoricalEvents(result.items,{asOf,count:3});
  write(`${JSON.stringify({contract:'read_only_aggregate_no_pii',as_of:asOf,returned_records:result.returned_count,resolved_events:resolved.events,conflicts:resolved.conflicts,missing:resolved.missing,unconfirmed:resolved.unconfirmed,unmatched:resolved.unmatched,invalid:resolved.invalid,complete:resolved.complete},null,2)}\n`);
  return resolved;
}

if(import.meta.url===`file://${process.argv[1]}`){const resolved=await main();if(!resolved.complete)process.exitCode=2;}

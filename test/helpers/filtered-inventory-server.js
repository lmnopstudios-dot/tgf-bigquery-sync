import {filteredInventoryFixture} from './filtered-inventory.js';
import {createCurrentStockService} from '../../oracle/current-stock.js';
import {createOracleBaselineDispatcher} from '../../oracle/baseline-dispatcher.js';
import {createBigQueryExportStore} from '../../oracle/product-priority-storage.js';
import {createMemoryAnalysisJobStore} from '../../oracle/analysis-jobs.js';
import {acceptanceServer} from './oracle-acceptance.js';
export const jsonCanonical=v=>Array.isArray(v)?v.map(jsonCanonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,jsonCanonical(v[k])])):v;
export async function filteredInventoryServer({durable=true,fixture=null,jobStore=null,...options}={}){
 const f=fixture||filteredInventoryFixture(options),artifacts=new Map(),sql=[];
 const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async q=>{sql.push(q);if(q.query.startsWith('SELECT'))return [artifacts.has(q.params.id)?[{artifact_json:jsonCanonical(artifacts.get(q.params.id))}]:[]];if(q.query.startsWith('MERGE'))artifacts.set(q.params.id,JSON.parse(q.params.artifact));return [[]];}};
 const exportStore=createBigQueryExportStore({bigquery,project:'fixture'}),service=createCurrentStockService({...f,artifactStore:exportStore}),baseline=createOracleBaselineDispatcher({currentStock:service});
 const jobs=jobStore||createMemoryAnalysisJobStore(),originalCreate=jobs.create;jobs.create=args=>originalCreate({...args,payload_json:jsonCanonical(args.payload_json)});
 const h=await acceptanceServer({baseline,exportStore},{durable,jobStore:jobs});return{...f,...h,artifacts,sql,baseline};
}

// Bounded read-only diagnostic. Only aggregate counts and schema names leave memory.
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {boundedFetch} from '../customer-identity/runtime.js';
import {read} from '../customer-identity/operations.js';
import {fq} from '../customer-identity/collect.js';
import {emailFields} from '../customer-identity/historical-evidence.js';

const bump=(o,k)=>{o[k]=(o[k]||0)+1;};
export function summarizeRecords(records,resource) {
  const counts={},fields={};
  for(const r of records){
    if(!r||typeof r!=='object'||Array.isArray(r))throw Error('Invalid record');
    const kind=r.customer_id===0||r.customer_id==='0'?'woo_guest':r.customer_id==null?'woo_id_omitted_or_null':'woo_id_present';
    bump(counts,kind);
    if(resource==='customers'){
      bump(counts,/^[1-9]\d*$/.test(String(r.metorik_customer_id))?'metorik_id_present':'metorik_id_missing');
      if(r.metorik_customer_id!=null&&r.customer_id!=null)bump(counts,String(r.metorik_customer_id)===String(r.customer_id)?'ids_equal':'ids_different');
    }
    for(const f of emailFields(r))bump(fields,`${kind}/${f.field}/${f.state}`);
  }
  return {records:records.length,counts,email_fields:fields};
}
export async function sampleMetorik({key,fetchImpl=fetch}) {
  const budget={requests:0,bytes:0,maxRequests:5,maxBytes:8388608},request=boundedFetch(budget,fetchImpl),out=[];
  const signal=AbortSignal.timeout(45000);
  for(const resource of ['customers','orders']){
    // No guessed type filters, hidden pagination, fields projection or retries.
    for(let page=1;page<=(resource==='customers'?3:2);page++){
      try {
        if(!key)throw Error('Configuration unavailable');
        const url=new URL(`https://app.metorik.com/api/v1/store/${resource}`);
        url.searchParams.set('per_page','10');url.searchParams.set('page',String(page));
        const response=await request(url,{headers:{Accept:'application/json',Authorization:`Bearer ${key}`},signal,redirect:'error'});
        if(!response.ok){out.push({resource,page,status:'http_failure',http_status:response.status});break;}
        const body=await response.json(),records=Array.isArray(body)?body:Array.isArray(body?.data)?body.data:body?.[resource];
        if(!Array.isArray(records)||records.length>10)throw Error('Invalid bounded collection');
        out.push({resource,page,status:'succeeded',...summarizeRecords(records,resource)});
        if(records.length<10||body?.pagination?.has_more_pages===false)break;
      }catch{out.push({resource,page,status:'unavailable_or_invalid_response'});break;}
    }
  }
  return {samples:out,requests:budget.requests,bytes:budget.bytes,
    limitation:'Bounded pages do not guarantee both guest and registered records. Missing strata remain untested; no upstream absence or ID relationship is inferred.'};
}
export function discoverySql(project,dataset) {
  const schema=fq(project,dataset,'COLUMNS').replace('COLUMNS`','INFORMATION_SCHEMA.COLUMNS`');
  return `SELECT table_name,column_name,data_type FROM ${schema} WHERE REGEXP_CONTAINS(LOWER(CONCAT(table_name,' ',column_name)),r'email|raw|json|customer|order|export|migrat') ORDER BY table_name,column_name LIMIT 501`;
}
export async function diagnose({bigquery,project,env=process.env,fetchImpl=fetch}) {
  const result={read_only:true,api:{},warehouse:{}};
  for(const [store,alias] of [['ww','UK'],['usd','US']])result.api[store]=await sampleMetorik({key:env[`METORIK_${alias}_API_KEY`],fetchImpl});
  for(const dataset of ['metorik_uk','metorik_us','woocommerce_uk','woocommerce_us','commerce']){
    try{
      const [rows]=await read(bigquery,discoverySql(project,dataset));
      if(rows.length>500)throw Error('Schema cap exceeded');
      const samples={};
      const tables=[...new Set(rows.map(r=>r.table_name))].filter(t=>/^[A-Za-z0-9_]+$/.test(t)&&/order|customer|raw|export|migrat/i.test(t));
      for(const table of tables.slice(0,5)){
        try{
          const [payloads]=await read(bigquery,`SELECT TO_JSON_STRING(t) payload FROM ${fq(project,dataset,table)} t ORDER BY TO_JSON_STRING(t) LIMIT 20`);
          let retainedBytes=0;
          const records=payloads.map(r=>{const size=Buffer.byteLength(r.payload||'');retainedBytes+=size;if(size>2097152||retainedBytes>8388608)throw Error('Retained payload cap exceeded');return JSON.parse(r.payload);});
          const raw=[];let invalidRaw=0;
          for(const record of records)for(const [field,value] of Object.entries(record))if(/raw|json/i.test(field)&&value!=null){
            try{const parsed=typeof value==='string'?JSON.parse(value):value;if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))raw.push(parsed);}catch{invalidRaw++;}
          }
          samples[table]={status:'succeeded',retained:summarizeRecords(records,table==='customers'?'customers':'orders'),raw:summarizeRecords(raw,'orders'),invalid_raw_json:invalidRaw};
        }catch{samples[table]={status:'unavailable_or_invalid_payload'};}
      }
      result.warehouse[dataset]={status:'succeeded',columns:rows.map(r=>({table_name:r.table_name,column_name:r.column_name,data_type:r.data_type})),samples,unsampled_tables:Math.max(0,tables.length-5)};
    }catch{result.warehouse[dataset]={status:'unavailable_or_schema_bound'};}
  }
  return result;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  if(process.argv.length>2)throw Error('Read-only diagnostic takes no arguments');
  const {bigquery,project}=createBigQueryClient();
  diagnose({bigquery,project}).then(r=>{console.log(JSON.stringify(r));if(Object.values(r.api).some(s=>s.samples.some(p=>p.status!=='succeeded'))||Object.values(r.warehouse).some(s=>s.status!=='succeeded'))process.exitCode=2;})
    .catch(()=>{console.error(JSON.stringify({read_only:true,status:'unavailable'}));process.exitCode=2;});
}

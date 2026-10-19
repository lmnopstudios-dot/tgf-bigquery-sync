// Execute generated snapshot/join/date/filter SQL against typed production-shaped
// fixtures. This adapter covers the used SQL subset, not BigQuery dry-run acceptance.
import { BigQuery } from '@google-cloud/bigquery';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
let DatabaseSync;
try{({DatabaseSync}=require('node:sqlite'));}catch(error){if(error.code!=='ERR_UNKNOWN_BUILTIN_MODULE')throw error;}
export const sqlFixtureAvailable=Boolean(DatabaseSync);
import { ORDER_VALUE_SCHEMA } from '../../oracle/order-value-schema.js';

const split=sql=>{
  const parts=[];let depth=0,start=0,quote=null;
  for(let i=0;i<sql.length;i++){const c=sql[i];if(quote){if(c===quote)quote=null;continue;}if(c==="'"||c==='"'){quote=c;continue;}if(c==='('||c==='[')depth++;if(c===')'||c===']')depth--;if(c===','&&depth===0){parts.push(sql.slice(start,i));start=i+1;}}
  parts.push(sql.slice(start));return parts;
};
const object=(columns,requireAs=false)=>`json_object(${split(columns).flatMap(col=>{const m=col.trim().match(/^([\s\S]+)\s+([a-z_]+)$/);if(!m)throw Error('Unsupported STRUCT column: '+col);if(requireAs&&!/\sAS$/i.test(m[1]))throw Error('STRUCT field aliases require AS: '+col);return [`'${m[2]}'`,m[1].replace(/\sAS$/i,'')];}).join(',')})`;

export function fixtureBigQuery(components,{failCoverage=false}={}) {
  const db=new DatabaseSync(':memory:');const calls=[];const sdk=new BigQuery({projectId:'fixture'});
  db.function('DATE',{varargs:true},(value,zone='UTC')=>value==null?null:new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value)));
  db.function('IF',(condition,yes,no)=>condition?yes:no);
  db.function('SNAPSHOT',{varargs:true},(...values)=>JSON.stringify(values));
  db.aggregate('countif',{start:0,step:(n,value)=>n+(value?1:0)});
  db.aggregate('bit_or',{start:0,step:(n,value)=>n|value});
  for(const [table,columns] of Object.entries(ORDER_VALUE_SCHEMA)){
    db.exec(`CREATE TABLE ${table} (${Object.entries(columns).map(([name,type])=>`${name} ${type==='NUMERIC'?'REAL':'TEXT'}`).join(',')})`);
    for(const row of components[table]||[])db.prepare(`INSERT INTO ${table} VALUES (${Object.keys(columns).map(()=>'?').join(',')})`).run(...Object.keys(columns).map(c=>row[c]??null));
  }
  const translate=input=>{
    let sql=input.replace(/`[^`]+\.shopify_data\.([a-z_]+)`/g,'$1')
      .replace(/TO_JSON_STRING\(STRUCT\(([^)]+)\)\)/g,'SNAPSHOT($1)')
      .replace(/SELECT \* FROM (order_[a-z_]+) QUALIFY ROW_NUMBER\(\) OVER\((.*?)\)=1/g,'SELECT * FROM (SELECT *,ROW_NUMBER() OVER($2) snapshot_rank FROM $1) WHERE snapshot_rank=1')
      .replace(/AS STRING/g,'AS TEXT')
      .replace(/DATE '([0-9-]+)'/g,"DATE('$1')");
    for(let idx=sql.indexOf('COUNTIF(');idx>=0;idx=sql.indexOf('COUNTIF(')){
      let end=idx+8,depth=1;for(;depth;end++){if(sql[end]==='(')depth++;if(sql[end]===')')depth--;}
      sql=sql.slice(0,idx)+'COALESCE(countif('+sql.slice(idx+8,end-1)+'),0)'+sql.slice(end);
    }
    if(input.includes('component_metrics AS')){
      const columns=['component','snapshot','business_date_field','row_count','distinct_orders','null_business_dates','first_business_timestamp','last_business_timestamp','first_business_date','last_business_date','first_collection','latest_collection','null_collection_timestamps','period_rows','period_orders','utc_period_rows','utc_london_date_differences'];
      sql=sql.replace('ARRAY(SELECT AS STRUCT * FROM component_metrics ORDER BY component,snapshot)',`(SELECT json_group_array(json_object(${columns.flatMap(c=>[`'${c}'`,c]).join(',')})) FROM (SELECT * FROM component_metrics ORDER BY component,snapshot))`);
      // BigQuery STRUCT and array literals -> SQLite JSON; parse balanced brackets.
      for(let idx=sql.indexOf('STRUCT(');idx>=0;idx=sql.indexOf('STRUCT(')){
        let end=idx+7,depth=1;for(;depth;end++){if(sql[end]==='(')depth++;if(sql[end]===')')depth--;}
        sql=sql.slice(0,idx)+object(sql.slice(idx+7,end-1),true)+sql.slice(end);
      }
      sql=sql.replace(/\[([\s\S]*?)\]/g,(_,inner)=>`json_array(${inner})`);
      const start=sql.indexOf('(SELECT AS STRUCT '),end=sql.indexOf('\n      FROM joined)',start);
      sql=sql.slice(0,start)+'(SELECT '+object(sql.slice(start+18,end))+' FROM joined)'+sql.slice(end+19);
      sql=sql.replace('EXCEPT DISTINCT','EXCEPT');
    }
    return sql;
  };
  const client={calls,db,dataset:()=>({getMetadata:async()=>[{location:'US'}]}),createQueryJob:async o=>{if(!o.dryRun&&!o.query.includes('INFORMATION_SCHEMA'))db.prepare(translate(o.query));if(!o.dryRun)return [{getQueryResults:()=>client.query(o),cancel:async()=>{}}];calls.push(o);db.prepare(translate(o.query));return [{metadata:{statistics:{totalBytesProcessed:'0'}}}];},query:async o=>{
    calls.push(o);
    if(o.query.includes('INFORMATION_SCHEMA'))return [Object.entries(ORDER_VALUE_SCHEMA).flatMap(([table_name,cols])=>Object.entries(cols).map(([column_name,data_type])=>({table_name,column_name,data_type,is_nullable:'YES'})))];
    if(failCoverage&&o.query.includes('represented_location_orders'))throw {code:403,errors:[{reason:'accessDenied'}]};
    const sql=translate(o.query).replace(/TYPEOF\(@([a-z_]+)\)/g,(_,name)=>`'${o.types?.[name]||'STRING'}'`);const params=Object.fromEntries((o.params?sdk.buildQueryParams_(o.params,o.types).params:[]).filter(p=>sql.includes('@'+p.name)).map(p=>[p.name,p.parameterValue.value??null]));
    const rows=db.prepare(sql).all(params).map(row=>({...row}));
    if(o.query.includes('component_metrics AS'))for(const row of rows)for(const key of ['components','period_intersections','all_snapshot_intersections','period_candidate_intersections','filter_stages','join_and_date_scope']){
      row[key]=JSON.parse(row[key]);if(Array.isArray(row[key]))row[key]=row[key].map(v=>typeof v==='string'?JSON.parse(v):v);
    }
    return [rows];
  }};
  return client;
}

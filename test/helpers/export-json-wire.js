import assert from 'node:assert/strict';
import {createBigQueryExportStore} from '../../oracle/product-priority-storage.js';
// Exercise production export serialization and hydration. Model BigQuery JSON's
// object-key canonicalization; never sort arrays or alter scalar values.
export function exportJsonWire(){
 const rows=new Map(),calls=[];
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 const bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async q=>{
  calls.push(q);assert.equal(q.location,'US');const p=q.params;
  if(q.query.startsWith('CREATE TABLE'))return [[]];
  const key=p.owner+':'+p.id;
  if(q.query.startsWith('MERGE ')){if(!rows.has(key))rows.set(key,JSON.stringify(canonical(JSON.parse(p.artifact))));return [[]];}
  if(q.query.startsWith('SELECT artifact_json'))return [rows.has(key)?[{artifact_json:rows.get(key)}]:[]];
  throw Error('Unexpected export storage SQL');
 }};
 return {rows,calls,store:createBigQueryExportStore({bigquery,project:'fixture'})};
}

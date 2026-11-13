import {BigQuery} from '@google-cloud/bigquery';
import {performanceFixture} from './loyalty-performance-fixture.js';
import {exportJsonWire} from './export-json-wire.js';
const MONEY=['original_order_gross','observed_aov','retained_lifetime_refunds'];
export function sdkLoyaltyFixture({large=false,invalid=false,failure}={}){
 const f=performanceFixture(failure),original=f.bigquery.query;
 f.bigquery.query=async q=>{
  const result=await original(q);
  if(q.labels?.operation!=='performance_purchasing')return result;
  return [result[0].map(row=>{
   const fields=Object.keys(row).map(name=>({name,type:MONEY.includes(name)?q.query.includes('AS STRING) '+name)?'STRING':'NUMERIC':typeof row[name]==='number'?'FLOAT64':'STRING'}));
   const values=fields.map(({name})=>({v:MONEY.includes(name)?large?'12345678901234567890.123456789':String(row[name]):row[name]}));
   const decoded=BigQuery.mergeSchemaWithRows_({fields},[{f:values}],{})[0];
   if(invalid)decoded.observed_aov={unrecognized:true};
   return decoded;
  })];
 };
 f.exportStore=exportJsonWire().store;return f;
}

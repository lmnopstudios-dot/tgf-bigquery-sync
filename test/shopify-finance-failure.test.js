import test from 'node:test';
import assert from 'node:assert/strict';
import common from '@google-cloud/common';
import {financeFailureJson,rememberFinanceFailure} from '../shopify/finance-failure.js';
import {promote,run} from '../shopify/finance-refresh.js';
const partial=()=>new common.util.PartialFailureError({errors:[{errors:[{reason:'invalid',message:'Invalid timestamp in field created_at: private@example.org Bearer secret'}],row:{email:'private@example.org',access_token:'secret'}}],response:{insertErrors:[{index:0,errors:[{reason:'invalid'}]}]}});
test('actual SDK empty-message row failure retains bounded useful metadata without row data',()=>{
 const e=partial();assert.equal(e.message,'');
 const text=financeFailureJson(e,{stage:'staging_insert',table:'order_locations',batch_index:1,run_id:'d34d93ce-2da6-4e19-9241-9646197e022b'}),d=JSON.parse(text);
 assert.equal(d.error_name,'PartialFailureError');assert.equal(d.stage,'staging_insert');assert.deepEqual(d.reasons,['invalid']);assert.deepEqual(d.categories,['date_time']);assert.deepEqual(d.fields,['created_at']);assert.equal(d.error_entries,1);
 assert.doesNotMatch(text,/private@example|Bearer|secret|access_token|"row"|message/);assert.ok(text.length<1000);
});
test('unknown empty failures are nonempty and envelope bounds hold under hostile nested input',()=>{
 assert.equal(JSON.parse(financeFailureJson(Error(''))).detail,'unclassified_failure');
 const e=Object.assign(Error('private key data'),{name:'arbitrary@example.org',code:403,errors:Array.from({length:1000},()=>({errors:Array.from({length:50},()=>({reason:'invalid',message:'Invalid numeric timestamp required field created_at updated_at order_id synced_at refund_id streaming buffer'})),row:{secret:'sensitive'}})),response:{jobReference:{jobId:'job_safe_123'}}});
 const text=financeFailureJson(e,{stage:'arbitrary SQL',table:'private',run_id:'secret'}),d=JSON.parse(text);
 assert.ok(text.length<=1000);assert.equal(d.sample_truncated,true);assert.equal(d.http_status,403);assert.equal(d.warehouse_job_id,'job_safe_123');assert.equal(d.stage,'unknown');assert.equal(d.table,undefined);assert.doesNotMatch(text,/sensitive|private|secret|SQL/);
});
test('staging partial failure keeps the original exception, records stage/table, never promotes or advances a watermark',async()=>{
 const error=partial(),calls=[],deletes=[];
 const bigquery={query:async q=>{calls.push(q);return [[]];},dataset:()=>({table:name=>({insert:async()=>{throw error;},delete:async()=>deletes.push(name)})})};
 const data={orders:[{order_id:'synthetic'}],financials:[],refunds:[]};
 await assert.rejects(promote({bigquery,project:'p',runId:'d34d93ce-2da6-4e19-9241-9646197e022b',start:'2026-10-19T12:17:24.265Z',end:'2026-10-19T16:17:29.778Z',data,pages:1,mode:'scheduled',runRecorded:true}),e=>e===error);
 assert.equal(calls.filter(c=>c.query.startsWith('BEGIN TRANSACTION')).length,0);
 const record=calls.find(c=>c.query.includes("SET status='failed'"));const d=JSON.parse(record.params.error);assert.equal(d.stage,'staging_insert');assert.equal(d.table,'order_locations');assert.equal(d.batch_index,0);assert.deepEqual(d.reasons,['invalid']);assert.equal(deletes.length,3);assert.equal(JSON.parse(financeFailureJson(error)).stage,'staging_insert');
});
test('SQL promotion failure keeps SQL/values private but retains the failed job reference',async()=>{
 const error=Object.assign(Error('Unrecognized name: private@example.org'),{code:400,errors:[{reason:'invalidQuery',message:'Unrecognized name: total_refunded_presentment'}],response:{jobReference:{jobId:'promotion_job_123'}}}),calls=[];
 const bigquery={query:async q=>{calls.push(q);if(q.query.startsWith('BEGIN TRANSACTION'))throw error;return [[]];},dataset:()=>({table:()=>({insert:async()=>{},delete:async()=>{}})})};
 await assert.rejects(promote({bigquery,project:'p',runId:'d34d93ce-2da6-4e19-9241-9646197e022b',start:'2026-10-19T12:17:24.265Z',end:'2026-10-19T16:17:29.778Z',data:{orders:[],financials:[],refunds:[]},pages:1,mode:'scheduled',runRecorded:true}),e=>e===error);
 const d=JSON.parse(calls.find(c=>c.query.includes("SET status='failed'")).params.error);assert.equal(d.stage,'promotion');assert.equal(d.warehouse_job_id,'promotion_job_123');assert.deepEqual(d.reasons,['invalidQuery']);assert.equal(calls.filter(c=>c.query.startsWith('BEGIN TRANSACTION')).length,1);
});
test('fetch failure is recorded once, has no source retry or promotion, and is rethrown',async()=>{
 let fetches=0;const error=Error(''),calls=[];
 const bigquery={query:async q=>{calls.push(q);return [[]];}};
 await assert.rejects(run({options:{mode:'collect',project:'p',dataset:'shopify_data',start:'2026-10-19T12:17:24.265Z',end:'2026-10-19T16:17:29.778Z',maxPages:1},bigquery,graphql:async()=>{fetches++;throw error;}}),e=>e===error);
 assert.equal(fetches,1);const records=calls.filter(c=>c.query.includes("SET status='failed'"));assert.equal(records.length,1);assert.equal(JSON.parse(records[0].params.error).stage,'fetch');assert.ok(!calls.some(c=>c.query.startsWith('BEGIN TRANSACTION')));
 rememberFinanceFailure(error,{stage:'promotion'});assert.equal(JSON.parse(financeFailureJson(error)).stage,'fetch');
});

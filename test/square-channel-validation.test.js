import test from 'node:test';
import assert from 'node:assert/strict';
import {squareChannelValidationSql,validateChannelAggregate,validateSquareChannels,CHANNEL_LIMITS} from '../diagnostics/square-channel-validation.js';
const good=()=>[{eligible_orders:3,outcomes:[{channel:'Unknown',channel_reason:'no_exact_payment_join',orders:3,payment_rows:0,completed_payments:0,card_present_payments:0}],payment_shapes:[]}];
test('narrow validation SQL reads orders/payments only and returns codes/counts, not identities or business reports',()=>{
 const sql=squareChannelValidationSql('gf-full-data');const tables=[...sql.matchAll(/`([^`]+)`/g)].map(m=>m[1]);assert.deepEqual([...new Set(tables)].sort(),['gf-full-data.square_data.orders','gf-full-data.square_data.payments']);assert.match(sql,/card_details_entry_method/);assert.match(sql,/card_details\.entry_method/);assert.match(sql,/2026-10-19/);assert.doesNotMatch(sql,/identity_reporting_extensions|retention_members|product_journeys|INSERT INTO|CREATE TABLE/);
});
test('aggregate validation reconciles all orders, permits genuinely Unknown channels and rejects unsafe fields',()=>{
 assert.doesNotThrow(()=>validateChannelAggregate(good()));const missing=good();missing[0].eligible_orders=4;assert.throws(()=>validateChannelAggregate(missing));const privateRows=good();privateRows[0].outcomes[0].customer_id='refused';assert.throws(()=>validateChannelAggregate(privateRows));const invalid=good();invalid[0].outcomes[0].channel='In-store';assert.throws(()=>validateChannelAggregate(invalid));
 const conflict=good();conflict[0].outcomes[0]={channel:'In-store',channel_reason:'completed_card_present_at_order_location',orders:3,completed_payments:3,card_present_payments:3,missing_payment_location:0,conflicting_payment_location:1,conflicting_entry_method:0,missing_payment_type:0,noncard_completed_payments:0,missing_entry_method:0,nonpresent_completed_payments:0};assert.throws(()=>validateChannelAggregate(conflict));
});
function fixture({estimate='100',result=good()}={}){const calls=[];return {calls,createQueryJob:async o=>{calls.push(o);if(o.dryRun)return [{metadata:{statistics:{totalBytesProcessed:estimate}}}];return [{id:o.jobId,getQueryResults:async()=>[result,null,{jobComplete:true,totalRows:'1'}],getMetadata:async()=>[{status:{state:'DONE'},statistics:{query:{totalBytesBilled:'10485760'}}}]}];}};}
test('one free dry run precedes one bounded aggregate execution; unknown classifications are not turned into success counts',async()=>{
 const b=fixture(),events=[];assert.equal(await validateSquareChannels({bigquery:b,project:'gf-full-data',location:'US',emit:e=>events.push(e)}),true);assert.equal(b.calls.length,2);assert.equal(b.calls[0].dryRun,true);assert.equal(b.calls[1].maximumBytesBilled,CHANNEL_LIMITS.bytes);assert.equal(b.calls[1].jobTimeoutMs,45000);assert.deepEqual(events.at(-1).rows,good());
});
test('oversized or unavailable dry-run estimate stops before any data job',async()=>{
 for(const estimate of [undefined,'1000000001']){const b=fixture({estimate:estimate??'unavailable'}),events=[];assert.equal(await validateSquareChannels({bigquery:b,project:'gf-full-data',location:'US',emit:e=>events.push(e)}),false);assert.equal(b.calls.length,1);assert.equal(events.at(-1).status,'unavailable');}
});

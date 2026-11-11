import test from 'node:test';
import assert from 'node:assert/strict';
import {provision,setupGuardSql} from '../loyaltylion/sync.js';
import {TABLES} from '../loyaltylion/contracts.js';
import {reviewedConfig} from './helpers/loyalty-fixture.js';
test('provision uses typed guard nulls and a singleton FROM source; no collection',async()=>{
 const queries=[];
 const config=reviewedConfig();
 const bigquery={dataset:()=>({
   getMetadata:async()=>[{location:'US'}],
   table:name=>({exists:async()=>[true],getMetadata:async()=>[{schema:{fields:TABLES[name]}}]})
 }),query:async q=>{queries.push(q);return [[]];}};
 await provision({bigquery,project:'fixture',config,env:{LOYALTYLION_COLLECTION_ENABLED:'true'},apply:true});
 assert.equal(queries.length,1);
 const sql=queries[0].query;
 assert.equal(sql,setupGuardSql('fixture',config.dataset));
 assert.match(sql,/SELECT @program_id,CAST\(NULL AS STRING\),CAST\(NULL AS TIMESTAMP\) FROM UNNEST\(\[1\]\) AS seed WHERE NOT EXISTS/);
 assert.match(sql,/BEGIN TRANSACTION;[\s\S]*LOYALTY_GUARD_SINGLETON[\s\S]*COMMIT TRANSACTION;/);
 assert.deepEqual(queries[0].types,{program_id:'STRING'});
});

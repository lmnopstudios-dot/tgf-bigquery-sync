import test from 'node:test';
import assert from 'node:assert/strict';
import { BigQuery } from '@google-cloud/bigquery';
import { DOMAIN_PROPERTY, WWW_PROPERTY, PROPERTIES, normalizePage, aggregate, canonicalDaily, validateRows } from '../search-console/semantic.js';
import { dateParameters, fetchRows, validateAccess, promotionSql, parseArgs, syncSummary, emitSyncSuccess, partialFailureDiagnostics, promote } from '../search-console/sync.js';
import { redactSecrets } from '../diagnostics/search-console-access.js';
import { validationQuery, coverageQuery, validate } from '../diagnostics/search-console-semantic-validation.js';

test('governed identifiers and scopes are exact',()=>assert.deepEqual(PROPERTIES,[{source_property:DOMAIN_PROPERTY,property_scope:'domain',property_hostname:'thegreatfroglondon.com'},{source_property:WWW_PROPERTY,property_scope:'url_prefix',property_hostname:'www.thegreatfroglondon.com'}]));
test('property access requires both properties with full access',async()=>{await validateAccess({sites:{list:async()=>({data:{siteEntry:PROPERTIES.map(p=>({siteUrl:p.source_property,permissionLevel:'siteFullUser'}))}})}});await assert.rejects(()=>validateAccess({sites:{list:async()=>({data:{siteEntry:[]}})}}),/not available/)});
test('DATE parameters use BigQuery DATE serialization',()=>{const p=dateParameters('2025-05-06','2025-05-07');assert.equal(p.startDate.value,'2025-05-06');assert.equal(p.endDate.value,'2025-05-07')});
test('page normalization preserves path identity and drops scheme query fragment',()=>assert.deepEqual(normalizePage('HTTPS://WWW.Example.COM/A/%2F?q=1#x'),{normalized_hostname:'www.example.com',normalized_path:'/A/%2F'}));
test('CTR and position aggregate by impressions',()=>assert.deepEqual(aggregate([{clicks:1,impressions:10,position:2},{clicks:3,impressions:30,position:6}]),{clicks:4,impressions:40,ctr:.1,position:5}));
test('canonical prefers Domain, falls back to www, and represents unavailable without zeroes',()=>{const base={property_scope:'domain',coverage_status:'available',ctr:.1,position:2};const rows=[{...base,source_property:DOMAIN_PROPERTY,date:'2025-05-06',clicks:1,impressions:10},{...base,source_property:WWW_PROPERTY,date:'2025-05-06',clicks:9,impressions:10},{...base,property_scope:'url_prefix',source_property:WWW_PROPERTY,date:'2025-05-07',clicks:0,impressions:0,ctr:0,position:null}];const c=canonicalDaily(rows,'2025-05-06','2025-05-08','now');assert.equal(c[0].clicks,1);assert.equal(c[0].selection_reason,'preferred_domain_property');assert.equal(c[1].clicks,0);assert.equal(c[1].selection_reason,'fallback_www_property');assert.equal(c[2].clicks,null);assert.equal(c[2].coverage_status,'unavailable')});
test('duplicate semantic keys and invalid metrics are rejected',()=>{const r={source_property:DOMAIN_PROPERTY,property_scope:'domain',property_hostname:'thegreatfroglondon.com',date:'2025-05-06',clicks:1,impressions:2,ctr:.5,position:1};assert.throws(()=>validateRows('daily',[r,r]),/duplicate/);assert.throws(()=>validateRows('daily',[{...r,clicks:3}]),/invalid metrics/)});
test('pagination is bounded and requests only final data',async()=>{const calls=[];const client={searchanalytics:{query:async x=>{calls.push(x);return {data:{rows:calls.length===1?[{keys:['x']}]:[]}}}}};const rows=await fetchRows(client,DOMAIN_PROPERTY,'2025-05-06','2025-05-07',['date'],{maxRows:4,pageSize:2});assert.equal(rows.length,1);assert.equal(calls[0].requestBody.dataState,'final');assert.equal(calls.length,1);const full={searchanalytics:{query:async()=>({data:{rows:[{},{}]}})}};await assert.rejects(()=>fetchRows(full,DOMAIN_PROPERTY,'2025-05-06','2025-05-07',['date'],{maxRows:4,pageSize:2}),/bounded/)});
test('promotion is property-scoped, transactional and stage-owned',()=>{const sql=promotionSql('p','search_console','daily','_stage_daily_inv_domain');assert.match(sql,/source_property=@sourceProperty/);assert.match(sql,/BEGIN TRANSACTION/);assert.match(sql,/COMMIT TRANSACTION/);assert.match(sql,/_stage_daily_inv_domain/)});
test('range parser enforces history, final lag, and bounded ranges',()=>{const now=new Date('2026-09-18T00:00:00Z');assert.equal(parseArgs(['--start','2026-09-08','--end','2026-09-15'],now).endDate,'2026-09-15');assert.throws(()=>parseArgs(['--start','2026-09-16','--end','2026-09-16'],now),/latest final/)});
test('validator covers canonical and dimensional anti-mixing semantics',()=>{const q=validationQuery('p');assert.match(q,/canonical_mismatch/);assert.match(q,/canonical_dimension_mixed_property/);assert.match(q,/preferred_domain_property/);assert.match(q,/fallback_www_property/)});
test('validator coverage query does not use the reserved ROWS keyword as an implicit alias',()=>{const invalid='SELECT COUNT(*) rows,COUNT(DISTINCT date) dates';assert.equal(invalid.toUpperCase().indexOf('ROWS')+1,17);assert.match(invalid,/COUNT\(\*\) rows/i);const corrected=coverageQuery('p');assert.match(corrected,/COUNT\(\*\) AS `rows`/);assert.doesNotMatch(corrected,/COUNT\(\*\)\s+rows\b/i)});
test('validator executes corrected coverage SQL and returns structured coverage',async()=>{const queries=[];const bigquery={query:async options=>{queries.push(options.query);return queries.length===1?[[]]:[[{rows:7,dates:7,expected:7}]]}};const result=await validate({bigquery,project:'p',startDate:'2026-09-08',endDate:'2026-09-14'});assert.equal(result.status,'valid');assert.equal(result.coverage.rows,7);assert.equal(queries[1],coverageQuery('p'))});
test('sync summary reports property staging, canonical selection, range, and cutoff',()=>{const data={daily:[{source_property:DOMAIN_PROPERTY},{source_property:WWW_PROPERTY}],queries:[],pages:[{source_property:DOMAIN_PROPERTY}],device_country:[],canonical_daily:[{selection_reason:'preferred_domain_property',coverage_status:'available'},{selection_reason:'fallback_www_property',coverage_status:'available'},{selection_reason:'no_available_property_evidence',coverage_status:'unavailable'}]};const result=syncSummary({startDate:'2026-09-08',endDate:'2026-09-14',finalDataCutoff:'2026-09-15'},data);assert.equal(result.status,'success');assert.equal(result.governed_properties_processed,2);assert.deepEqual(result.property_rows[0].tables.pages,{staged:1,inserted:1});assert.deepEqual(result.canonical_selection_counts,{preferred_domain:1,fallback_www:1,unavailable:1});assert.equal(result.final_data_cutoff,'2026-09-15')});
test('sync output is emitted only after success and never on failure',async()=>{const output=[];await emitSyncSuccess(async()=>({status:'success'}),line=>output.push(line));assert.equal(JSON.parse(output[0]).status,'success');output.length=0;await assert.rejects(()=>emitSyncSuccess(async()=>{throw new Error('promotion failed')},line=>output.push(line)),/promotion failed/);assert.deepEqual(output,[])});
test('query omission is not materialized as zero rows',()=>{const c=canonicalDaily([], '2025-05-06','2025-05-06');assert.equal(c[0].coverage_status,'unavailable');assert.equal(c[0].clicks,null)});

test('credentials, tokens, and private keys are redacted',()=>assert.doesNotMatch(redactSecrets('Bearer abc.def private_key=secret'),/abc\.def|secret/));

test('partial insert failures are bounded and expose safe fields without rejected row values',()=>{
  const rows=Array.from({length:12},(_,i)=>({query:`private query ${i}`,page:`https://private.example/${i}`,access_token:`token-${i}`}));
  const errors=rows.map((row,i)=>({row,errors:[{reason:'invalid',message:i===0?'No such field: unexpected_field. Value: private query 0':`Invalid value for type INT64: private query ${i} at https://private.example/${i} Bearer access-${i} private_key=-----BEGIN PRIVATE KEY-----secret-${i}-----END PRIVATE KEY-----`}] }));
  const output=partialFailureDiagnostics({name:'PartialFailureError',errors},{table:'queries',sourceProperty:DOMAIN_PROPERTY,batchSize:rows.length,rows});
  assert.equal(output.operation,'bigquery_stage_insert');
  assert.equal(output.logical_target_table,'queries');
  assert.equal(output.source_property,DOMAIN_PROPERTY);
  assert.equal(output.failed_row_count,12);
  assert.equal(output.reported_failure_count,10);
  assert.equal(output.failures_truncated,true);
  assert.equal(output.failures[0].row_index,0);
  assert.equal(output.failures[0].field,'unexpected_field');
  assert.equal(output.failures[0].reason,'invalid');
  assert.equal(output.error_class,'PartialFailureError');
  assert.doesNotMatch(JSON.stringify(output),/private query|private\.example|token-|access-|secret-|BEGIN PRIVATE KEY/);
});

test('staging partial failure has table/property context, skips promotion, and cleans every owned stage',async()=>{
  const created=[],deleted=[],queries=[];
  const data=Object.fromEntries([...['daily','queries','pages','device_country','canonical_daily'].map(name=>[name,[]])]);
  for(const property of PROPERTIES)data.queries.push({source_property:property.source_property,query:'sensitive query'});
  const bigquery={
    dataset:()=>({
      createTable:async name=>created.push(name),
      table:name=>({
        insert:async rows=>{if(name.includes('_stage_queries_')&&name.endsWith('_domain')){const error=new Error();error.name='PartialFailureError';error.errors=[{row:rows[0],errors:[{reason:'invalid',message:'Invalid value for type INT64: sensitive query'}]}];throw error}},
        delete:async()=>deleted.push(name)
      })
    }),
    query:async options=>queries.push(options)
  };
  await assert.rejects(()=>promote({bigquery,project:'project',dataset:'search_console',data,startDate:'2026-09-08',endDate:'2026-09-14',invocationId:'test'}),error=>{
    const output=JSON.parse(error.message);
    assert.equal(output.logical_target_table,'queries');
    assert.equal(output.source_property,DOMAIN_PROPERTY);
    assert.equal(output.batch_size,1);
    assert.doesNotMatch(error.message,/sensitive query/);
    return true;
  });
  assert.equal(queries.length,0,'coordinated promotion must not run');
  assert.equal(created.length,2);
  assert.deepEqual(new Set(deleted),new Set(created));
});

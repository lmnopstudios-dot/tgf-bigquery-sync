import test from 'node:test';
import assert from 'node:assert/strict';
import { BigQuery } from '@google-cloud/bigquery';
import { DOMAIN_PROPERTY, WWW_PROPERTY, PROPERTIES, normalizePage, aggregate, canonicalDaily, validateRows } from '../search-console/semantic.js';
import { dateParameters, fetchRows, validateAccess, promotionSql, parseArgs, syncSummary, emitSyncSuccess, partialFailureDiagnostics, promote, collect, SCHEMA_FIELDS, STAGE_INSERT_BATCH_SIZE, stageCreationSql, assertStageSchema } from '../search-console/sync.js';
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

test('high-volume dimensional collection and staging are iterative, complete, batched, and transactional',async()=>{
  const domainQueries=130000,wwwQueries=20000,pageSize=25000,calls=[];
  const client={searchanalytics:{query:async({siteUrl,requestBody})=>{
    calls.push({siteUrl,dimensions:requestBody.dimensions.join(','),startRow:requestBody.startRow,rowLimit:requestBody.rowLimit});
    if(requestBody.dimensions.join(',')==='date')return {data:{rows:requestBody.startRow===0?[{keys:['2025-05-06'],clicks:1,impressions:10,ctr:.1,position:2}]:[]}};
    if(requestBody.dimensions.join(',')!=='date,query')return {data:{rows:[]}};
    const total=siteUrl===DOMAIN_PROPERTY?domainQueries:wwwQueries;
    const count=Math.max(0,Math.min(requestBody.rowLimit,total-requestBody.startRow));
    return {data:{rows:Array.from({length:count},(_,index)=>({keys:['2025-05-06',`${siteUrl===DOMAIN_PROPERTY?'domain':'www'} query ${requestBody.startRow+index}`],clicks:1,impressions:2,ctr:.5,position:1}))}};
  }}};
  const data=await collect({client,startDate:'2025-05-06',endDate:'2025-05-06',maxRows:150000,syncedAt:'2026-09-18T00:00:00.000Z'});
  assert.equal(data.queries.length,domainQueries+wwwQueries);
  assert.equal(calls.filter(call=>call.siteUrl===DOMAIN_PROPERTY&&call.dimensions==='date,query').length,Math.ceil(domainQueries/pageSize));
  assert.equal(calls.filter(call=>call.siteUrl===WWW_PROPERTY&&call.dimensions==='date,query').length,1);
  assert.equal(data.canonical_daily.length,1);
  assert.equal(data.canonical_daily[0].selection_reason,'preferred_domain_property');

  const stages=new Map(),insertions=[],deleted=[],promotions=[];
  const bigquery={
    query:async options=>{
      if(options.query.startsWith('CREATE OR REPLACE')){const [,stage,table]=options.query.match(/`project\.search_console\.([^`]+)`[\s\S]+LIKE `project\.search_console\.([^`]+)`/);stages.set(stage,table);return [[]]}
      if(options.query.startsWith('SELECT column_name'))return [SCHEMA_FIELDS[stages.get(options.params.stage)].map(field=>({column_name:field.name,data_type:field.type,is_nullable:'YES'}))];
      promotions.push(options);return [[]];
    },
    dataset:()=>({table:stage=>({insert:async rows=>insertions.push({stage,size:rows.length}),delete:async()=>deleted.push(stage)})})
  };
  await promote({bigquery,project:'project',dataset:'search_console',data,startDate:'2025-05-06',endDate:'2025-05-06',invocationId:'volume'});
  const domainStage='_stage_queries_volume_domain',wwwStage='_stage_queries_volume_url_prefix';
  assert.equal(insertions.filter(item=>item.stage===domainStage).reduce((sum,item)=>sum+item.size,0),domainQueries);
  assert.equal(insertions.filter(item=>item.stage===wwwStage).reduce((sum,item)=>sum+item.size,0),wwwQueries);
  assert.ok(insertions.every(item=>item.size<=STAGE_INSERT_BATCH_SIZE));
  assert.equal(promotions.length,1);
  assert.equal(deleted.length,stages.size);
  const summary=syncSummary({startDate:'2025-05-06',endDate:'2025-05-06'},data);
  assert.deepEqual(summary.property_rows.map(item=>item.tables.queries.inserted),[domainQueries,wwwQueries]);
});

test('collection failures include safe phase, table, property, range, count, and class context',async()=>{
  const client={searchanalytics:{query:async()=>{const error=new RangeError('Maximum call stack size exceeded at https://private.example/?token=secret');throw error}}};
  await assert.rejects(()=>collect({client,startDate:'2025-05-06',endDate:'2025-05-07'}),error=>{
    const output=JSON.parse(error.message);
    assert.deepEqual(output,{operation:'search_console_collection',logical_target_table:'daily',source_property:DOMAIN_PROPERTY,requested_range:{start_date:'2025-05-06',end_date:'2025-05-07'},accumulated_row_count:0,batch_size:null,batch_offset:null,error_class:'RangeError',message:'Maximum call stack size exceeded'});
    assert.doesNotMatch(error.message,/private\.example|token=secret/);
    return true;
  });
});
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

test('the production unknown-field symptom is safely recognized as a malformed stage',()=>{
  const fields=['coverage_status','property_hostname','date','position','ctr','clicks','coverage_status'];
  const rows=fields.map((_,index)=>({private_value:`row-${index}`}));
  const errors=rows.map((row,index)=>({row,errors:[{reason:'invalid',message:`Unknown field: ${fields[index]}`}]}));
  const output=partialFailureDiagnostics({name:'PartialFailureError',errors},{table:'daily',sourceProperty:DOMAIN_PROPERTY,batchSize:7,rows});
  assert.deepEqual(output.failures.map(failure=>failure.field),fields);
  assert.equal(output.failed_row_count,7);
  assert.doesNotMatch(JSON.stringify(output),/private_value|row-/);
});

test('all five stages use fully qualified CREATE OR REPLACE TABLE LIKE production DDL',()=>{
  for(const table of Object.keys(SCHEMA_FIELDS)){
    const sql=stageCreationSql('project','search_console',`_stage_${table}_run`,table);
    assert.ok(sql.startsWith(`CREATE OR REPLACE TABLE \`project.search_console._stage_${table}_run\``));
    assert.ok(sql.includes(`LIKE \`project.search_console.${table}\``));
    assert.match(sql,/expiration_timestamp/);
  }
});

test('stage schema assertion accepts every exact schema and safely rejects malformed schemas',async()=>{
  for(const [table,fields] of Object.entries(SCHEMA_FIELDS)){
    const bigquery={query:async()=>[fields.map(field=>({column_name:field.name,data_type:field.type,is_nullable:'YES'}))]};
    await assertStageSchema({bigquery,project:'project',dataset:'search_console',stage:`_stage_${table}`,table});
  }
  const malformed=SCHEMA_FIELDS.daily.slice(0,2).map(field=>({column_name:`${field.name} ${field.type}`,data_type:'STRING',is_nullable:'YES'}));
  await assert.rejects(()=>assertStageSchema({bigquery:{query:async()=>[malformed]},project:'project',dataset:'search_console',stage:'_stage_daily_bad',table:'daily'}),error=>{
    const output=JSON.parse(error.message);
    assert.equal(output.operation,'stage_schema_mismatch');
    assert.equal(output.logical_target_table,'daily');
    assert.ok(output.missing_fields.includes('date'));
    assert.deepEqual(output.unexpected_fields,['source_property STRING','property_scope STRING']);
    assert.doesNotMatch(error.message,/row|query text|page URL/);
    return true;
  });
});

test('staging partial failure has table/property context, skips promotion, and cleans every owned stage',async()=>{
  const created=[],deleted=[],promotions=[];
  const data=Object.fromEntries([...['daily','queries','pages','device_country','canonical_daily'].map(name=>[name,[]])]);
  for(const property of PROPERTIES)data.queries.push({source_property:property.source_property,query:'sensitive query'});
  const bigquery={
    dataset:(dataset,options)=>({
      table:name=>({
        insert:async rows=>{assert.equal(options.projectId,'project');if(name.includes('_stage_queries_')&&name.endsWith('_domain')){const error=new Error();error.name='PartialFailureError';error.errors=[{row:rows[0],errors:[{reason:'invalid',message:'Invalid value for type INT64: sensitive query'}]}];throw error}},
        delete:async()=>deleted.push(name)
      })
    }),
    query:async options=>{
      if(options.query.startsWith('CREATE OR REPLACE')){created.push(options.query.match(/`project\.search_console\.([^`]+)`/)[1]);return [[]]}
      if(options.query.startsWith('SELECT column_name')){const table=created.at(-1).match(/^_stage_(daily|queries|pages|device_country|canonical_daily)_/)[1];return [SCHEMA_FIELDS[table].map(field=>({column_name:field.name,data_type:field.type,is_nullable:'YES'}))]}
      promotions.push(options);return [[]];
    }
  };
  await assert.rejects(()=>promote({bigquery,project:'project',dataset:'search_console',data,startDate:'2026-09-08',endDate:'2026-09-14',invocationId:'test'}),error=>{
    const output=JSON.parse(error.message);
    assert.equal(output.logical_target_table,'queries');
    assert.equal(output.source_property,DOMAIN_PROPERTY);
    assert.equal(output.batch_size,1);
    assert.doesNotMatch(error.message,/sensitive query/);
    return true;
  });
  assert.equal(promotions.length,0,'coordinated promotion must not run');
  assert.equal(created.length,2);
  assert.deepEqual(new Set(deleted),new Set(created));
});

test('stage creation and schema assertion finish before insert; schema failure skips promotion and cleans up',async()=>{
  const events=[];
  const data=Object.fromEntries(Object.keys(SCHEMA_FIELDS).map(table=>[table,[]]));
  data.daily=[{source_property:DOMAIN_PROPERTY,date:'2026-09-08'}];
  const bigquery={
    query:async options=>{
      if(options.query.startsWith('CREATE OR REPLACE')){events.push('create-complete');return [[]]}
      if(options.query.startsWith('SELECT column_name')){events.push('schema-mismatch');return [[{column_name:'wrong',data_type:'STRING',is_nullable:'YES'}]]}
      events.push('promotion');return [[]];
    },
    dataset:(dataset,options)=>({table:name=>({insert:async()=>events.push('insert'),delete:async()=>{assert.equal(options.projectId,'project');events.push(`cleanup:${name}`)}})})
  };
  await assert.rejects(()=>promote({bigquery,project:'project',dataset:'search_console',data,startDate:'2026-09-08',endDate:'2026-09-14',invocationId:'test'}),/stage_schema_mismatch/);
  assert.deepEqual(events.slice(0,2),['create-complete','schema-mismatch']);
  assert.equal(events.includes('insert'),false);
  assert.equal(events.includes('promotion'),false);
  assert.equal(events.filter(event=>event.startsWith('cleanup:')).length,1);
});

test('successful staging preserves coordinated same-range replacement and cleans all owned stages',async()=>{
  const stages=new Map(),promotions=[],deleted=[];
  const data=Object.fromEntries(Object.keys(SCHEMA_FIELDS).map(table=>[table,[]]));
  const bigquery={
    query:async options=>{
      if(options.query.startsWith('CREATE OR REPLACE')){
        const [,stage,table]=options.query.match(/`project\.search_console\.([^`]+)`[\s\S]+LIKE `project\.search_console\.([^`]+)`/);
        stages.set(stage,table);return [[]];
      }
      if(options.query.startsWith('SELECT column_name'))return [SCHEMA_FIELDS[stages.get(options.params.stage)].map(field=>({column_name:field.name,data_type:field.type,is_nullable:'YES'}))];
      promotions.push(options);return [[]];
    },
    dataset:()=>({table:stage=>({insert:async()=>{},delete:async()=>deleted.push(stage)})})
  };
  await promote({bigquery,project:'project',dataset:'search_console',data,startDate:'2026-09-08',endDate:'2026-09-14',invocationId:'test'});
  assert.equal(stages.size,PROPERTIES.length*4+1);
  assert.equal(promotions.length,1);
  assert.match(promotions[0].query,/BEGIN TRANSACTION;/);
  assert.match(promotions[0].query,/DELETE FROM `project\.search_console\.daily` WHERE source_property=@sourceProperty0 AND date BETWEEN @startDate AND @endDate;/);
  assert.match(promotions[0].query,/INSERT INTO `project\.search_console\.canonical_daily` SELECT \* FROM `project\.search_console\._stage_canonical_daily_test`;/);
  assert.match(promotions[0].query,/COMMIT TRANSACTION;/);
  assert.equal(deleted.length,stages.size);
});

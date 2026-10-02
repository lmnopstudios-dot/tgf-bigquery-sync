import test from 'node:test';
import assert from 'node:assert/strict';
import {createKlaviyoClient,parseRetryAfter,redactKlaviyo} from '../klaviyo/client.js';
import {discover,metricCatalogue,reportBody,resolveReportWindow,PILOT,REPORT_STATISTICS} from '../klaviyo/discovery.js';
import {requireGate,normalizeReport,collectPilot,serializeAttributionSettings,persist,persistenceQuery,assertBuffersReady} from '../klaviyo/sync.js';
import {extractDiscoveryJson,prepareManifest,REVIEWED_ATTRIBUTION_SETTINGS} from '../klaviyo/prepare-manifest.js';
import {classifyKlaviyoQuestion,KLAVIYO_TOOL_DEFINITIONS,createKlaviyoEmailService,klaviyoAggregateQuery} from '../oracle/klaviyo-email.js';
import {diagnose,inventoryQuery,physicalRowsQuery,physicalRowsTimestampLiteralQuery} from '../diagnostics/klaviyo-production.js';
import {recoveryQueries,verifyRecovery} from '../diagnostics/klaviyo-refresh-recovery.js';

const response=(body,status=200,headers={get:()=>null})=>({ok:status<300,status,headers,json:async()=>body});
test('pagination follows next links and enforces its bound',async()=>{let n=0;const fetchImpl=async()=>response(n++?{data:[],links:{next:null}}:{data:[{id:'one'}],links:{next:'/api/metrics?page=2'}}),client=createKlaviyoClient({apiKey:'pk_secretsecret',revision:'2026-01-15',fetchImpl,sleep:async()=>{}});assert.equal((await client.paginate('/api/metrics')).pages,2);n=0;await assert.rejects(client.paginate('/api/metrics',{maxPages:1}),/pagination bound/);});
test('discovery omits unsupported page size for metrics and flows and follows their next links',async()=>{
  const requested=[];
  const pages=new Map([
    ['https://a.klaviyo.com/api/metrics',{data:[{id:'m1',attributes:{name:'Opened Email'}}],links:{next:'https://a.klaviyo.com/api/metrics?page%5Bcursor%5D=metric-next'}}],
    ['https://a.klaviyo.com/api/metrics?page%5Bcursor%5D=metric-next',{data:[{id:'m2',attributes:{name:'Clicked Email'}}],links:{next:null}}],
    ["https://a.klaviyo.com/api/campaigns?filter=equals(messages.channel,'email')&page[size]=100",{data:[{id:'c1'}],links:{next:null}}],
    ['https://a.klaviyo.com/api/flows',{data:[{id:'f1'}],links:{next:'/api/flows?page%5Bcursor%5D=flow-next'}}],
    ['https://a.klaviyo.com/api/flows?page%5Bcursor%5D=flow-next',{data:[{id:'f2'}],links:{next:null}}]
  ]);
  const fetchImpl=async(url,options)=>{requested.push({url,method:options.method});assert.ok(pages.has(url),`unexpected URL: ${url}`);return response(pages.get(url));};
  const client=createKlaviyoClient({apiKey:'pk_secretsecret',revision:'2026-01-15',fetchImpl,sleep:async()=>{}});
  const result=await discover({client,timezone:'Europe/London',currency:'GBP'});
  assert.deepEqual(requested.map(({url})=>url).sort(),[...pages.keys()].sort());
  assert.ok(requested.every(({method})=>method==='GET'));
  assert.deepEqual(result.metrics.map(({metric_id})=>metric_id),['m1','m2']);
  assert.equal(result.campaign_count,1);
  assert.equal(result.flow_count,2);
  assert.equal(result.read_only,true);
  assert.equal(result.approved_for_pilot,false);
});
test('429 retries are bounded and credentials are redacted',async()=>{let calls=0;const client=createKlaviyoClient({apiKey:'pk_secretsecret',revision:'2026-01-15',fetchImpl:async()=>{calls++;return response({},429)},maxRetries:2,sleep:async()=>{}});await assert.rejects(client.request('/api/metrics'),/HTTP 429/);assert.equal(calls,3);assert.equal(redactKlaviyo('Authorization: Klaviyo-API-Key pk_secretsecret'),'Authorization: Klaviyo-API-Key [REDACTED]');});
test('historical pacing is serialized and Retry-After is honored without an unsafe ten-second cap',async()=>{
  let clock=Date.parse('2026-10-02T00:00:00Z');const sleeps=[],seen=[];
  const client=createKlaviyoClient({apiKey:'pk_secretsecret',revision:'2026-07-15',minRequestIntervalMs:4000,maxElapsedMs:30000,now:()=>clock,sleep:async ms=>{sleeps.push(ms);clock+=ms;},fetchImpl:async()=>{seen.push(clock);return seen.length===1?response({},429,{get:name=>name.toLowerCase()==='retry-after'?'12':null}):response({data:[]});}});
  await client.request('/api/metrics');await client.request('/api/flows');
  assert.deepEqual(seen.map((value,index)=>index?value-seen[index-1]:0),[0,12000,4000]);assert.ok(sleeps.includes(12000));
  assert.equal(parseRetryAfter('Fri, 02 Oct 2026 00:00:20 GMT',Date.parse('2026-10-02T00:00:00Z')),20000);
});
test('Retry-After cannot push work beyond the elapsed-time bound',async()=>{const client=createKlaviyoClient({apiKey:'pk_secretsecret',revision:'2026-07-15',maxElapsedMs:5000,fetchImpl:async()=>response({},429,{get:()=> '6'}),sleep:async()=>{}});await assert.rejects(client.request('/api/metrics'),error=>error.code==='ELAPSED_BOUND');});
test('metric provenance distinguishes integrations and report requires account settings',()=>{assert.deepEqual(metricCatalogue([{id:'s',attributes:{name:'Placed Order',integration:{name:'Shopify'}}},{id:'w',attributes:{name:'Placed Order - WooCommerce'}}]).map(x=>x.integration),['shopify','woocommerce']);assert.throws(()=>reportBody('campaign','s',{}),/timezone/);});
test('campaign report request exactly follows the pinned 2026-07-15 contract',()=>{
  const campaign=reportBody('campaign','Xp9amv',{timezone:'Europe/London'});
  assert.deepEqual(campaign,{data:{type:'campaign-values-report',attributes:{statistics:['recipients','delivered','opens','opens_unique','clicks','clicks_unique','conversions','conversion_value','bounced','unsubscribes','spam_complaints'],timeframe:{start:'2026-08-01T00:00:00+01:00',end:'2026-09-01T00:00:00+01:00'},conversion_metric_id:'Xp9amv',filter:"equals(send_channel,'email')"}}});
  assert.equal(Object.hasOwn(campaign.data.attributes.timeframe,'key'),false);
});
test('flow report request exactly follows the pinned 2026-07-15 contract',()=>{
  const flow=reportBody('flow','Xp9amv',{timezone:'Europe/London'});
  assert.deepEqual(flow,{data:{type:'flow-values-report',attributes:{statistics:['recipients','delivered','opens','opens_unique','clicks','clicks_unique','conversions','conversion_value','bounced','unsubscribes','spam_complaints'],timeframe:{start:'2026-08-01T00:00:00+01:00',end:'2026-09-01T00:00:00+01:00'},conversion_metric_id:'Xp9amv',filter:"equals(send_channel,'email')"}}});
  assert.equal(Object.hasOwn(flow.data.attributes.timeframe,'key'),false);
});
test('JSON:API validation errors are bounded and redact request secrets',async()=>{
  const client=createKlaviyoClient({apiKey:'pk_secretsecret',revision:'2026-07-15',fetchImpl:async()=>response({errors:[{code:'invalid',title:'Invalid input',detail:'metric Xp9amv rejected for pk_secretsecret',source:{pointer:'/data/attributes/conversion_metric_id'}}]},400),sleep:async()=>{}});
  await assert.rejects(client.request('/api/campaign-values-reports',{method:'POST',body:reportBody('campaign','Xp9amv',{timezone:'UTC'})}),error=>error.status===400&&error.validationErrors[0].detail==='metric [REDACTED] rejected for [REDACTED]'&&error.validationErrors[0].source.pointer==='/data/attributes/conversion_metric_id');
});
test('discovery retains successful probe evidence when the other report fails',async()=>{
  const client={paginate:async path=>path==='/api/metrics'?{data:[{id:'Xp9amv',attributes:{name:'Placed Order',integration:{name:'Shopify'}}}]}:{data:[]},request:async path=>{if(path.includes('campaign'))return {data:{attributes:{results:[{}]}}};throw Object.assign(new Error('bad request'),{status:400,code:'invalid',validationErrors:[{code:'invalid',title:'Invalid',detail:'Bad filter',source:{pointer:'/data/attributes/filter',parameter:null}}]});}};
  const result=await discover({client,timezone:'Europe/London',currency:'GBP',conversionMetricIds:['Xp9amv']});
  assert.equal(result.approved_for_pilot,false);assert.deepEqual(result.probes.map(x=>x.status),['available','failed']);assert.equal(result.probes[1].error.endpoint,'/api/flow-values-reports');assert.equal(result.probes[1].error.http_status,400);assert.equal(result.probes[1].error.errors[0].source.pointer,'/data/attributes/filter');
});
const probes=id=>['campaign','flow'].map(kind=>({kind,metric_id:id,status:'available'}));
const approvedManifest={gate_version:1,approved_for_pilot:true,approved_metric_ids:['s'],pilot:PILOT,timezone:'Europe/London',currency:'GBP',attribution_settings:REVIEWED_ATTRIBUTION_SETTINGS,probes:probes('s')};
const statistics=overrides=>Object.fromEntries(REPORT_STATISTICS.campaign.map(k=>[k,overrides?.[k]??1]));
test('production gate requires nonempty metrics, the exact window, and both probes',()=>{assert.equal(requireGate(approvedManifest,{timezone:'Europe/London',currency:'GBP',metricIds:['s']}),true);assert.throws(()=>requireGate(approvedManifest,{timezone:'Europe/London',currency:'GBP',metricIds:[]}),/At least one/);assert.throws(()=>requireGate({...approvedManifest,pilot:{start:PILOT.start,end:'2026-08-31T00:00:00'}},{timezone:'Europe/London',currency:'GBP',metricIds:['s']}),/exact pilot/);assert.throws(()=>requireGate({...approvedManifest,probes:probes('s').slice(0,1)},{timezone:'Europe/London',currency:'GBP',metricIds:['s']}),/flow discovery/);});
test('timezone resolver stores the same instants sent in the request',()=>{const window=resolveReportWindow({timezone:'Europe/London'});assert.deepEqual(window,{timeframe:{start:'2026-08-01T00:00:00+01:00',end:'2026-09-01T00:00:00+01:00'},startInstant:'2026-07-31T23:00:00.000Z',endInstant:'2026-08-31T23:00:00.000Z'});});
test('normalization uses reviewed grouping IDs, exact instants, and serialized settings',()=>{const payload={data:{attributes:{results:[{groupings:{campaign_id:'c1',campaign_message_id:'cm1'},statistics:statistics({conversion_value:12})}]}}};const row=normalizeReport(payload,{kind:'campaign',metricId:'shopify-id',currency:'GBP',timezone:'Europe/London',revision:'2026-07-15',retrievedAt:'2026-09-02T00:00:00Z',attributionSettings:REVIEWED_ATTRIBUTION_SETTINGS})[0];assert.equal(row.entity_id,'c1');assert.equal(row.message_id,'cm1');assert.equal(row.report_start,'2026-07-31T23:00:00.000Z');assert.deepEqual(JSON.parse(row.attribution_settings),REVIEWED_ATTRIBUTION_SETTINGS);});
test('normalization rejects blank IDs, fallback shapes, and missing statistics',()=>{const options={kind:'flow',metricId:'s',currency:'GBP',timezone:'Europe/London',revision:'2026-07-15',retrievedAt:'now',attributionSettings:REVIEWED_ATTRIBUTION_SETTINGS};assert.throws(()=>normalizeReport({data:{attributes:{results:[{groupings:{flow_id:'f',flow_message_id:''},statistics:statistics()}]}}},options),/blank persistence ID/);assert.throws(()=>normalizeReport({data:{attributes:{results:[{id:'f',stats:statistics()}]}}},options),/reviewed grouping/);const incomplete=statistics();delete incomplete.delivered;assert.throws(()=>normalizeReport({data:{attributes:{results:[{groupings:{flow_id:'f',flow_message_id:'fm'},statistics:incomplete}]}}},options),/Missing delivered/);});
test('report pagination uses page_cursor and rejects duplicates or incomplete bounds',async()=>{const calls=[];const client={request:async(_path,{body})=>{calls.push(body);return calls.length===1?{data:{attributes:{results:[{groupings:{campaign_id:'c1',campaign_message_id:'m1'},statistics:statistics()}],next_cursor:'next'}}}:{data:{attributes:{results:[{groupings:{campaign_id:'c2',campaign_message_id:'m2'},statistics:statistics()}],next_cursor:null}}};}};const rows=await collectPilot({client:{request:async(path,opts)=>path.includes('campaign')?client.request(path,opts):({data:{attributes:{results:[],next_cursor:null}}})},manifest:approvedManifest,revision:'2026-07-15',timezone:'Europe/London',currency:'GBP',metricIds:['s']});assert.equal(rows.length,2);assert.equal(calls[0].data.attributes.page_cursor,undefined);assert.equal(calls[1].data.attributes.page_cursor,'next');const endless={request:async()=>({data:{attributes:{results:[],next_cursor:crypto.randomUUID()}}})};await assert.rejects(collectPilot({client:endless,manifest:approvedManifest,revision:'2026-07-15',timezone:'Europe/London',currency:'GBP',metricIds:['s'],maxReportPages:2}),e=>e.code==='PARTIAL_FAILURE');});
test('duplicate persistence grain is rejected before persistence',async()=>{const result={groupings:{campaign_id:'c',campaign_message_id:'m'},statistics:statistics()};const client={request:async path=>({data:{attributes:{results:path.includes('campaign')?[result,result]:[],next_cursor:null}}})};await assert.rejects(collectPilot({client,manifest:approvedManifest,revision:'2026-07-15',timezone:'Europe/London',currency:'GBP',metricIds:['s']}),/Duplicate Klaviyo/);});
test('attribution settings structure is exact',()=>{assert.equal(typeof serializeAttributionSettings(REVIEWED_ATTRIBUTION_SETTINGS),'string');assert.throws(()=>serializeAttributionSettings({...REVIEWED_ATTRIBUTION_SETTINGS,extra:true}),/structure/);});
test('manifest preparation extracts JSON from npm output and records provenance',()=>{const source={gate_version:1,pilot:PILOT,timezone:'Europe/London',currency:'GBP',probes:probes('Xp9amv'),approved_for_pilot:false};const raw=`npm notice something\n${JSON.stringify(source,null,2)}\nnpm notice done\n`;assert.deepEqual(extractDiscoveryJson(raw),source);const manifest=prepareManifest(raw,{reviewer:'A Reviewer',reviewedAt:'2026-09-30T12:00:00Z',metricIds:'Xp9amv',evidencePath:'/safe/evidence.log'});assert.equal(manifest.approved_for_pilot,true);assert.equal(manifest.review.source_evidence,'/safe/evidence.log');assert.equal(manifest.review.source_sha256.length,64);});
test('exact Oracle routes cover all requested questions',()=>{assert.equal(classifyKlaviyoQuestion('How did email campaigns and automated flows perform in August 2026?'),'get_klaviyo_email_performance');assert.equal(classifyKlaviyoQuestion('Which campaigns had strong clicks but weak attributed purchases?'),'get_klaviyo_click_purchase_opportunities');assert.equal(classifyKlaviyoQuestion('Compare Klaviyo with Shopify email-referrer traffic'),'compare_klaviyo_email_with_shopify_referrer');assert.equal(KLAVIYO_TOOL_DEFINITIONS.length,3);});
test('Oracle retrieval failure remains an error and never fallback zero figures',async()=>{const service=createKlaviyoEmailService({project:'p',bigquery:{query:async()=>{throw new Error('missing')},getDatasets:async()=>[]}});await assert.rejects(service('get_klaviyo_email_performance',{start_date:'2026-08-01',end_date:'2026-08-31'}),e=>e.code==='KLAVIYO_RETRIEVAL_FAILED'&&!/zero performance$/.test(e.message));});
test('Oracle interprets non-overlapping monthly boundaries in their recorded timezone',()=>{const query=klaviyoAggregateQuery('p');assert.match(query,/DATE\(report_start,reporting_timezone\)=DATE_TRUNC/);assert.match(query,/DATE\(report_end,reporting_timezone\)=DATE_ADD\(DATE\(report_start,reporting_timezone\),INTERVAL 1 MONTH\)/);assert.match(query,/MIN\(DATE\(report_start,reporting_timezone\)\)/);assert.doesNotMatch(query,/DATE\(report_start\)>=/);});
test('production diagnostic inventories physical rows and fails closed on an Oracle contradiction',async()=>{
  const row={report_kind:'campaign',entity_id:'c',message_id:'m',report_start:'2026-07-31T23:00:00.000Z',report_end:'2026-08-31T23:00:00.000Z',conversion_metric_id:'s',reporting_timezone:'Europe/London',...statistics()};let reads=0;
  const bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async options=>{reads++;if(options.query===inventoryQuery('p'))return [[{report_kind:'campaign',conversion_metric_id:'s',report_start:row.report_start,report_end:row.report_end,reporting_timezone:'Europe/London',row_count:1}]];if(options.query===physicalRowsQuery('p')||options.query===physicalRowsTimestampLiteralQuery('p',row.report_start,row.report_end))return [[row]];return [[[]]];}};
  const result=await diagnose({bigquery,project:'p',apiRows:[row],timezone:'Europe/London',metricIds:['s']});assert.equal(reads,5);assert.equal(result.status,'read_only_diagnostic_failed');assert.equal(result.stored_rows,1);assert.equal(result.literal_control_rows,1);assert.equal(result.persisted_evidence_rows,0);assert.equal(result.comparison.consistent,false);assert.deepEqual(result.oracle_bindings,{start_date:'2026-08-01',end_date:'2026-08-31'});
  const timestamp=result.query_bindings.parameterized.parameters.report_start;assert.equal(timestamp.declared_parameter_type,'TIMESTAMP');assert.equal(timestamp.runtime_constructor,'BigQueryTimestamp');assert.deepEqual(timestamp.encoded_value,{value:row.report_start});assert.match(result.query_bindings.independent_typed_timestamp_literal.sql,/report_start=TIMESTAMP\('2026-07-31T23:00:00\.000Z'\)/);
});

test('Klaviyo diagnostic reconciles typed and literal reads while treating live statistic drift as collection-time change',async()=>{
  const stored={report_kind:'campaign',entity_id:'c',message_id:'m',report_start:'2026-07-31T23:00:00.000Z',report_end:'2026-08-31T23:00:00.000Z',conversion_metric_id:'Xp9amv',reporting_timezone:'Europe/London',...statistics({conversions:52})},live={...stored,opens_unique:2};
  const aggregate={report_kind:'campaign',entity_id:'c',conversion_metric_id:'Xp9amv',currency:'GBP',reporting_timezone:'Europe/London',api_revision:'2026-07-15',attribution_settings:'{}',report_period_semantics:'report',recipients:1,delivered:1,unique_opens:1,unique_clicks:1,attributed_conversion_events:52,attributed_conversion_value:1,bounces:1,unsubscribes:1,spam_complaints:1,evidence_rows:1};
  const calls=[],bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async options=>{calls.push(options);if(options.query===inventoryQuery('p'))return [[]];if(options.query===physicalRowsQuery('p'))return [[stored]];if(options.query===physicalRowsTimestampLiteralQuery('p',stored.report_start,stored.report_end))return [[stored]];return [[aggregate]];}};
  const result=await diagnose({bigquery,project:'p',apiRows:[live],timezone:'Europe/London',metricIds:['Xp9amv']});
  assert.equal(result.status,'read_only_diagnostic_passed');assert.equal(result.comparison.live_attribution_statistics_changed,true);assert.equal(result.comparison.identity_consistent,true);assert.equal(result.comparison.binding_control.consistent,true);assert.equal(result.comparison.oracle_statistics.consistent,true);
  const bound=calls.find(call=>call.query===physicalRowsQuery('p'));assert.equal(bound.params.report_start.constructor.name,'BigQueryTimestamp');assert.equal(bound.params.report_end.constructor.name,'BigQueryTimestamp');assert.deepEqual(bound.types,{report_start:'TIMESTAMP',report_end:'TIMESTAMP',reporting_timezone:'STRING',metric_ids:['STRING']});
});

test('durable account config and bounded windows reject silent drift and broad history',async()=>{
  const {readFile}=await import('node:fs/promises');
  const {requireAccountConfig,validateBoundedWindow,rollingWindow}=await import('../klaviyo/sync.js');
  const config=JSON.parse(await readFile(new URL('../config/klaviyo-account.json',import.meta.url)));
  assert.equal(requireAccountConfig(config,{timezone:'Europe/London',currency:'GBP',metricIds:['Xp9amv']}),true);
  assert.throws(()=>requireAccountConfig({...config,attribution_settings:{...config.attribution_settings,unreviewed_setting:true}},{timezone:'Europe/London',currency:'GBP',metricIds:['Xp9amv']}),/invalid attribution_settings structure/);
  assert.throws(()=>validateBoundedWindow({start:'2020-01-01T00:00:00',end:'2021-01-01T00:00:00'}),/exceeds/);
  assert.deepEqual(rollingWindow({now:new Date('2026-10-01T12:00:00Z'),timezone:'Europe/London',rollingDays:7,attributionLagDays:5}),{start:'2026-09-20T00:00:00',end:'2026-09-27T00:00:00'});
  assert.deepEqual(rollingWindow({now:new Date('2026-10-01T23:30:00Z'),timezone:'Europe/London',rollingDays:7,attributionLagDays:5}),{start:'2026-09-21T00:00:00',end:'2026-09-28T00:00:00'});
});

test('metadata joins stable names without treating drafts as sent',async()=>{
  const {collectMetadata,joinMetadata,metadataPaths}=await import('../klaviyo/metadata.js');
  const requested=[],client={paginate:async path=>{requested.push(path);return {data:path.includes('campaigns')?[{id:'c1',attributes:{name:'LoyaltyLion Launch',status:'Draft'}}]:[{id:'f1',attributes:{name:'Welcome',status:'live'}}],included:[]}}};
  const metadata=await collectMetadata({client,retrievedAt:'2026-09-30T00:00:00Z'});
  assert.deepEqual(requested,[metadataPaths.campaign,metadataPaths.flow]);assert.equal(metadataPaths.flow,'/api/flows?include=flow-actions');assert.doesNotMatch(metadataPaths.flow,/page/);
  assert.equal(metadata[0].is_sent,false);assert.equal(metadata[0].subject,null);
  assert.equal(joinMetadata([{report_kind:'campaign',entity_id:'c1'}],metadata)[0].entity_name,'LoyaltyLion Launch');
});

test('metadata API failure identifies its bounded request and sanitized JSON:API fields',async()=>{
  const {collectWindow}=await import('../klaviyo/sync.js'),config=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../config/klaviyo-account.json',import.meta.url)));
  const result={groupings:{campaign_id:'c',campaign_message_id:'m'},statistics:statistics()},flowResult={groupings:{flow_id:'f',flow_message_id:'m'},statistics:statistics()};
  const client={request:async path=>({data:{attributes:{results:path.includes('campaign')?[result]:[flowResult],next_cursor:null}}}),paginate:async path=>{if(path.includes('campaigns'))return {data:[],included:[]};throw Object.assign(new Error('body must stay private'),{status:400,code:'invalid',validationErrors:[{code:'invalid',title:'Invalid input',detail:'page size is unsupported',source:{pointer:null,parameter:'page[size]'}}]});}};
  await assert.rejects(collectWindow({client,config,revision:'2026-07-15',start:'2026-08-01T00:00:00',end:'2026-09-01T00:00:00'}),error=>{const failure=error.failures[0];assert.equal(error.code,'PARTIAL_FAILURE');assert.deepEqual(failure,{kind:'metadata',stage:'metadata:flow',endpoint:'/api/flows?include=flow-actions',http_status:400,code:'invalid',errors:[{code:'invalid',title:'Invalid input',detail:'page size is unsupported',source:{pointer:null,parameter:'page[size]'}}],message:'Retrieval failed; sanitized details attached'});assert.doesNotMatch(JSON.stringify(error.failures),/body must stay private/);return true;});
});

test('metadata rejects missing stable IDs instead of joining or substituting empty data',async()=>{
  const {collectMetadata}=await import('../klaviyo/metadata.js');
  await assert.rejects(collectMetadata({client:{paginate:async()=>({data:[{attributes:{name:'unsafe fallback'}}],included:[]})}}),/stable ID/);
});

test('monthly Oracle contract prevents rolling or overlapping snapshot double counting',()=>{const sql=klaviyoAggregateQuery('p');assert.match(sql,/DATE_TRUNC\(@start_date,MONTH\)/);assert.match(sql,/INTERVAL 1 MONTH/);assert.match(sql,/ROW_NUMBER\(\).*retrieved_at DESC/);assert.match(sql,/DATE\(report_start,reporting_timezone\)=DATE_TRUNC/);});

test('refresh records failed status and can never report partial collection as success',async()=>{
  const {runRefresh}=await import('../klaviyo/refresh.js');const queries=[];
  const bigquery={query:async o=>{queries.push(o);return [[]]}};
  await assert.rejects(runRefresh({client:{request:async()=>{throw new Error('no')}},bigquery,project:'p',config:{...JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../config/klaviyo-account.json',import.meta.url))),refresh_policy:{rolling_days:7,attribution_lag_days:5,maximum_manual_days:92}},revision:'2026-07-15',args:['--start=2026-08-01','--end=2026-08-31']}));
  assert.equal(queries.length,2);assert.match(queries[1].query,/status='failed'/);assert.doesNotMatch(queries[1].query,/succeeded/);
  assert.equal(queries[0].params.started_at.constructor.name,'BigQueryTimestamp');assert.equal(queries[0].params.report_start.value,'2026-07-31T23:00:00.000Z');assert.equal(queries[0].params.report_end.value,'2026-08-31T23:00:00.000Z');
});

test('persistence uses query parameters rather than streaming inserts and atomically promotes both tables and status',async()=>{
  const calls=[],bigquery={query:async options=>{calls.push(options);return [[]]},dataset:()=>({table:()=>({getMetadata:async()=>[{}]})})};
  const row={report_kind:'campaign',channel:'email',entity_id:'c',entity_name:'Campaign',message_id:'m',report_start:'2026-07-31T23:00:00.000Z',report_end:'2026-08-31T23:00:00.000Z',report_period_semantics:'exact',conversion_metric_id:'s',metric_provenance:'stable',currency:'GBP',reporting_timezone:'Europe/London',api_revision:'2026-07-15',attribution_settings:'{}',...statistics(),retrieved_at:'2026-10-01T00:00:00Z'};
  const metadata={entity_kind:'campaign',entity_id:'c',entity_name:'Campaign',status:'sent',send_time:null,send_time_semantics:'source',message_ids:'["m"]',subject:null,preview_text:null,destination_links:'[]',source_endpoint:'/api/campaigns',retrieved_at:row.retrieved_at,is_sent:true};
  const result=await persist({bigquery,project:'p',rows:[row],metadata:[metadata],runId:'run-1',retrievedAt:row.retrieved_at});
  assert.equal(result.mode,'transactional_query_upsert');assert.equal(calls.length,2);
  const promotion=calls[1];assert.deepEqual(JSON.parse(promotion.params.report_payload),[row]);assert.deepEqual(JSON.parse(promotion.params.metadata_payload),[metadata]);
  assert.equal(promotion.params.retrieved_at.constructor.name,'BigQueryTimestamp');
  assert.match(promotion.query,/CREATE TEMP TABLE incoming_reports/);assert.match(promotion.query,/BEGIN TRANSACTION/);assert.match(promotion.query,/MERGE `p\.klaviyo\.message_performance`/);assert.match(promotion.query,/MERGE `p\.klaviyo\.entity_metadata`/);assert.match(promotion.query,/DELETE FROM `p\.klaviyo\.entity_metadata`/);assert.match(promotion.query,/status='succeeded'/);assert.match(promotion.query,/ASSERT @@row_count=1/);assert.match(promotion.query,/COMMIT TRANSACTION/);
});

test('retry SQL preserves the stable report grain and unrelated metadata without streaming writes',()=>{
  const sql=persistenceQuery('p','klaviyo',{promoteStatus:true});
  assert.match(sql,/T\.report_kind=S\.report_kind AND T\.entity_id=S\.entity_id AND T\.message_id=S\.message_id AND T\.report_start=S\.report_start AND T\.report_end=S\.report_end AND T\.conversion_metric_id=S\.conversion_metric_id/);
  assert.match(sql,/T\.entity_kind=S\.entity_kind AND T\.entity_id=S\.entity_id/);
  assert.doesNotMatch(sql,/table\.insert|INSERTALL|TRUNCATE/i);
  assert.ok(sql.indexOf('BEGIN TRANSACTION')<sql.indexOf('message_performance` T'));
  assert.ok(sql.indexOf('entity_metadata` T')<sql.indexOf("status='succeeded'"));
});

test('August recovery verification is bounded and read-only and exposes streaming-buffer state',async()=>{
  const queries=[],bigquery={dataset:()=>({table:name=>({getMetadata:async()=>[{streamingBuffer:name==='entity_metadata'?{estimatedRows:'2'}:undefined}]})}),query:async options=>{queries.push(options);return [[]]}};
  const result=await verifyRecovery({bigquery,project:'p'});
  assert.equal(result.status,'waiting_for_streaming_buffers');assert.equal(result.recovery_claimed,false);assert.equal(result.timestamp_binding_contract.runtime_constructor,'BigQueryTimestamp');assert.equal(result.window.report_start,'2026-07-31T23:00:00.000Z');assert.equal(result.window.report_end,'2026-08-31T23:00:00.000Z');assert.equal(result.checks.message_performance_streaming_buffer,null);assert.deepEqual(result.checks.entity_metadata_streaming_buffer,{estimatedRows:'2'});assert.equal(queries.length,5);assert.ok(queries.every(x=>x.maximumBytesBilled==='10000000000'&&x.useLegacySql===false));
  for(const sql of Object.values(recoveryQueries('p'))){assert.match(sql,/SELECT/);assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|DROP)\b/i);}
  assert.equal(queries[0].params.report_start.constructor.name,'BigQueryTimestamp');assert.equal(queries[4].params,undefined);assert.match(queries[4].query,/TIMESTAMP\('2026-07-31T23:00:00\.000Z'\)/);
});

test('buffer readiness blocks promotion without bypassing or issuing DML',async()=>{const calls=[],bigquery={dataset:()=>({table:name=>({getMetadata:async()=>[{streamingBuffer:name==='entity_metadata'?{estimatedRows:'122'}:undefined}]})}),query:async options=>{calls.push(options)}};await assert.rejects(assertBuffersReady({bigquery,project:'p'}),error=>error.code==='KLAVIYO_STREAMING_BUFFER_BLOCKED'&&error.recovery_status==='waiting_for_streaming_buffers'&&error.buffers.entity_metadata.estimatedRows==='122');assert.equal(calls.length,0);});

test('generated promotion line 47 is the entity metadata MERGE and all effects share one transaction',()=>{const lines=persistenceQuery('p','klaviyo',{promoteStatus:true}).split('\n');assert.match(lines[46],/^MERGE `p\.klaviyo\.entity_metadata`/);assert.ok(lines.indexOf('BEGIN TRANSACTION;')<46);assert.ok(lines.findIndex(line=>line.includes("status='succeeded'"))<lines.indexOf('COMMIT TRANSACTION;'));});


test('historical month planning is bounded and refuses unreviewed pre-Shopify substitution',async()=>{
  const {backfillPlan,applicableMetrics}=await import('../klaviyo/backfill.js');
  const config=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../config/klaviyo-account.json',import.meta.url)));
  assert.deepEqual(backfillPlan({args:['--from=2026-08','--through=2027-01','--max-months=2'],config}).months,['2026-08','2026-09']);
  assert.deepEqual(applicableMetrics(config,'2025-10'),[]);assert.equal(applicableMetrics(config,'2025-11')[0].integration,'shopify');assert.equal(applicableMetrics(config,'2026-07')[0].integration,'shopify');
});

test('historical discovery catalogues provenance but probes only explicitly selected metrics',async()=>{
  const {discoverHistory}=await import('../klaviyo/historical-discovery.js');
  const requested=[];
  const metrics=[
    {id:'Xp9amv',attributes:{name:'Placed Order',integration:{name:'Shopify'}}},
    {id:'woo-order',attributes:{name:'Order Placed',integration:{name:'WooCommerce'}}},
    {id:'form',attributes:{name:'Submitted Form',integration:{name:'Klaviyo'}}}
  ];
  const client={paginate:async path=>({data:path==='/api/metrics'?metrics:[]}),request:async(path,{body})=>{requested.push({path,metric:body.data.attributes.conversion_metric_id});return {data:{attributes:{results:[]}}};}};
  const result=await discoverHistory({client,timezone:'Europe/London',currency:'GBP',args:['--from=2026-03','--through=2026-03','--max-months=1']});
  assert.deepEqual(result.metrics.map(x=>x.metric_id),['Xp9amv','woo-order','form']);
  assert.deepEqual(result.selected_conversion_metric_ids,['Xp9amv']);
  assert.deepEqual(requested.map(x=>x.metric),['Xp9amv','Xp9amv']);
  assert.deepEqual(result.potential_woocommerce_purchase_metrics.map(x=>x.metric_id),['woo-order']);
  assert.ok(result.evidence.every(x=>x.status==='zero_rows'));
});

test('historical discovery stops at the call bound and identifies every unattempted task',async()=>{
  const {discoverHistory}=await import('../klaviyo/historical-discovery.js');
  let requests=0;
  const client={paginate:async path=>({data:path==='/api/metrics'?[{id:'Xp9amv',attributes:{name:'Placed Order',integration:{name:'Shopify'}}}]:[]}),request:async()=>{requests++;if(requests===2)throw Object.assign(new Error('bound'),{code:'CALL_BOUND'});return {data:{attributes:{results:[{}]}}};}};
  const result=await discoverHistory({client,timezone:'Europe/London',currency:'GBP',args:['--from=2026-03','--through=2026-04','--max-months=2']});
  assert.equal(requests,2);
  assert.deepEqual(result.evidence.map(x=>x.status),['successful','not_attempted_limit','not_attempted_limit','not_attempted_limit']);
  assert.deepEqual(result.first_unfinished_task,{month:'2026-03',metric_id:'Xp9amv',kind:'flow'});
  assert.match(result.resume_command,/--from=2026-03 .*--resume-month=2026-03 --resume-metric-id=Xp9amv --resume-report-kind=flow$/);
});

test('historical discovery resumes at the exact unfinished task without skipping it',async()=>{
  const {discoverHistory}=await import('../klaviyo/historical-discovery.js');
  const requested=[];
  const client={paginate:async path=>({data:path==='/api/metrics'?[{id:'Xp9amv',attributes:{name:'Placed Order',integration:{name:'Shopify'}}}]:[]}),request:async path=>{requested.push(path);return {data:{attributes:{results:[{}]}}};}};
  const result=await discoverHistory({client,timezone:'Europe/London',currency:'GBP',args:['--from=2026-03','--through=2026-04','--max-months=2','--metric-ids=Xp9amv','--resume-month=2026-03','--resume-metric-id=Xp9amv','--resume-report-kind=flow']});
  assert.deepEqual(requested,['/api/flow-values-reports','/api/campaign-values-reports','/api/flow-values-reports']);
  assert.deepEqual(result.evidence.map(x=>[x.month,x.kind]),[['2026-03','flow'],['2026-04','campaign'],['2026-04','flow']]);
  assert.equal(result.resume_command,null);
});

test('evidence resume preserves successes and zeros and retries only unfinished tasks',async()=>{
  const {discoverHistory}=await import('../klaviyo/historical-discovery.js');
  const prior={read_only:true,earliest_accessible_dated_metadata:{kind:'campaign',id:'old',date:'2025-11-02T10:00:00Z'},metrics:[{metric_id:'Xp9amv',name:'Placed Order',integration:'shopify'}],evidence:[
    {month:'2026-02',metric_id:'Xp9amv',kind:'campaign',integration:'shopify',status:'request_failed',http_status:429,code:'KLAVIYO_ERROR'},
    {month:'2026-02',metric_id:'Xp9amv',kind:'flow',integration:'shopify',status:'zero_rows',row_count:0},
    {month:'2026-03',metric_id:'Xp9amv',kind:'campaign',integration:'shopify',status:'successful',row_count:5},
    {month:'2026-03',metric_id:'Xp9amv',kind:'flow',integration:'shopify',status:'zero_rows',row_count:0}
  ]};
  const requested=[];const client={paginate:async path=>{if(path==='/api/metrics')throw Object.assign(new Error('refresh limited'),{status:429,code:'RATE_LIMITED'});return {data:[]};},request:async path=>{requested.push(path);return {data:{attributes:{results:[{}]}}};}};
  const result=await discoverHistory({client,timezone:'Europe/London',currency:'GBP',args:['--from=2026-02','--through=2026-03','--max-months=2'],previousEvidence:prior});
  assert.deepEqual(requested,['/api/campaign-values-reports']);
  assert.deepEqual(result.evidence.map(x=>[x.month,x.kind,x.status,x.row_count]),[['2026-02','campaign','successful',1],['2026-02','flow','zero_rows',0],['2026-03','campaign','successful',5],['2026-03','flow','zero_rows',0]]);
  assert.deepEqual(result.metadata_refresh.metrics,{status:'request_failed',http_status:429,code:'RATE_LIMITED'});assert.equal(result.earliest_accessible_dated_metadata.id,'old');assert.equal(result.resume_command,null);
});

test('daily schedule refreshes previous and current London calendar months',async()=>{
  const {scheduledMonths}=await import('../klaviyo/scheduled-refresh.js');
  assert.deepEqual(scheduledMonths(new Date('2026-10-01T12:00:00Z')),['2026-09','2026-10']);
});

test('coverage and successful zero activity promote in the same transaction',()=>{
  const sql=persistenceQuery('p','klaviyo',{promoteStatus:true,promoteCoverage:true});
  assert.match(sql,/MERGE `p\.klaviyo\.window_coverage`/);assert.match(sql,/status='collected'/);assert.match(sql,/@report_count row_count/);
  assert.ok(sql.indexOf('window_coverage')<sql.indexOf('COMMIT TRANSACTION;'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createKlaviyoClient,redactKlaviyo} from '../klaviyo/client.js';
import {discover,metricCatalogue,reportBody} from '../klaviyo/discovery.js';
import {requireGate,normalizeReport} from '../klaviyo/sync.js';
import {classifyKlaviyoQuestion,KLAVIYO_TOOL_DEFINITIONS,createKlaviyoEmailService} from '../oracle/klaviyo-email.js';

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
test('production gate blocks collection until explicit matching approval',()=>{const manifest={gate_version:1,approved_for_pilot:true,timezone:'Europe/London',currency:'GBP',attribution_settings:'dashboard recorded',probes:[{metric_id:'s',status:'available'}]};assert.equal(requireGate(manifest,{timezone:'Europe/London',currency:'GBP',metricIds:['s']}),true);assert.throws(()=>requireGate({...manifest,approved_for_pilot:false},{timezone:'Europe/London',currency:'GBP',metricIds:['s']}),/blocked/);assert.throws(()=>requireGate(manifest,{timezone:'Europe/London',currency:'USD',metricIds:['s']}),/do not match/);});
test('normalization preserves period semantics, currencies, and separate metric IDs',()=>{const payload={data:{attributes:{results:[{id:'c1',statistics:{delivered:10,clicks_unique:4,conversions:1,conversion_value:12}}]}}};const row=normalizeReport(payload,{kind:'campaign',metricId:'shopify-id',currency:'GBP',timezone:'Europe/London',revision:'2026-01-15',retrievedAt:'2026-09-02T00:00:00Z'})[0];assert.equal(row.currency,'GBP');assert.equal(row.conversion_metric_id,'shopify-id');assert.match(row.report_period_semantics,/not asserted/);});
test('exact Oracle routes cover all requested questions',()=>{assert.equal(classifyKlaviyoQuestion('How did email campaigns and automated flows perform in August 2026?'),'get_klaviyo_email_performance');assert.equal(classifyKlaviyoQuestion('Which campaigns had strong clicks but weak attributed purchases?'),'get_klaviyo_click_purchase_opportunities');assert.equal(classifyKlaviyoQuestion('Compare Klaviyo with Shopify email-referrer traffic'),'compare_klaviyo_email_with_shopify_referrer');assert.equal(KLAVIYO_TOOL_DEFINITIONS.length,3);});
test('Oracle retrieval failure remains an error and never fallback zero figures',async()=>{const service=createKlaviyoEmailService({project:'p',bigquery:{query:async()=>{throw new Error('missing')},getDatasets:async()=>[]}});await assert.rejects(service('get_klaviyo_email_performance',{start_date:'2026-08-01',end_date:'2026-08-31'}),e=>e.code==='KLAVIYO_RETRIEVAL_FAILED'&&!/zero performance$/.test(e.message));});

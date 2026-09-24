import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { assertStrictToolSchema, createProposalGenerator, needsProposalGeneration, normalizeModelProposal, proposalDiagnostic, PROPOSAL_INSTRUCTIONS, PROPOSE_GOVERNED_RECORDS_TOOL } from '../oracle/proposals.js';
import { redactError } from '../oracle/ui-security.js';
import { ShopifyThrottleError, SHOPIFY_RATE_LIMIT_MESSAGE } from '../oracle/shopifyql-throttle.js';
import { affinityJustified, partialAnswer, requestId, terminalMessage } from '../oracle/request-observability.js';

const env={ORACLE_UI_PASSWORD:'test-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012',ORACLE_UI_ADMIN_NAME:'test-admin'};
async function fixture(generateProposals=async()=>[]){
  const writes=[];
  const bigquery={dataset:()=>({table:()=>({insert:async rows=>writes.push(...rows)})}),query:async()=>[[]]};
  const browse=[];const knowledgeService={searchKnowledge:async input=>{browse.push({tool:'knowledge',input});return {items:[{id:'ev_existing',title:'Black Friday 2025',content:'Existing governed event',status:'confirmed'}],input}},getKnowledgeItem:async()=>({found:false,item:null}),searchMemory:async input=>{browse.push({tool:'memory',input});return {items:[],input}},getMemoryItem:async()=>({found:false,item:null})};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService,bigquery,project:'test',chat:async message=>({answer:`answer:${message}`,tools:['search_knowledge']}),generateProposals,env}));
  const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});const base=`http://127.0.0.1:${server.address().port}/api/oracle`;
  const request=(path,options={})=>fetch(base+path,options);return {server,request,writes,browse,base};
}
async function login(request,base){const response=await request('/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:new URL(base).origin},body:JSON.stringify({password:env.ORACLE_UI_PASSWORD})});const data=await response.json();const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');return {cookie,csrf:data.csrf};}
test('strict proposal tool is non-writing and permits only governed record variants',()=>{
  assert.equal(PROPOSE_GOVERNED_RECORDS_TOOL.name,'propose_governed_records');
  assert.equal(PROPOSE_GOVERNED_RECORDS_TOOL.strict,true);
  assert.equal(PROPOSE_GOVERNED_RECORDS_TOOL.parameters.additionalProperties,false);
  assert.equal(PROPOSE_GOVERNED_RECORDS_TOOL.parameters.properties.proposals.maxItems,12);
  assert.ok(PROPOSE_GOVERNED_RECORDS_TOOL.parameters.properties.proposals.items.anyOf);
  assert.match(PROPOSAL_INSTRUCTIONS,/empty proposals list for questions/i);
  assert.match(PROPOSAL_INSTRUCTIONS,/never save or write/i);
});

test('strict proposal schema recursively types properties, closes objects and types array items',()=>{
  assert.equal(assertStrictToolSchema(),true);
  const broken=structuredClone(PROPOSE_GOVERNED_RECORDS_TOOL.parameters);
  delete broken.properties.proposals.items.anyOf[2].properties.kind.type;
  assert.throws(()=>assertStrictToolSchema(broken),/kind must declare type or anyOf/);
  const untypedItem=structuredClone(PROPOSE_GOVERNED_RECORDS_TOOL.parameters);
  untypedItem.properties.proposals.items.anyOf[3].properties.evidence.items.properties.reference={maxLength:1000};
  assert.throws(()=>assertStrictToolSchema(untypedItem),/reference must declare type or anyOf/);
  for(const branch of PROPOSE_GOVERNED_RECORDS_TOOL.parameters.properties.proposals.items.anyOf){
    assert.equal(branch.additionalProperties,false);
    assert.deepEqual(new Set(branch.required),new Set(Object.keys(branch.properties)));
    assert.deepEqual(branch.properties.kind.type,'string');
  }
});

test('proposal generator makes one bounded tool-only model call and parses multiple candidates',async()=>{
  const calls=[];const candidates=[event('Campaign','2024-11-07','2024-11-10','Offer detail'),event('Online sale','2024-11-08','2024-11-10','08:00 GMT through midnight GMT')];
  const generate=createProposalGenerator({openai:{responses:{create:async input=>{calls.push(input);return {output:[{type:'function_call',name:'propose_governed_records',arguments:JSON.stringify({proposals:candidates})}]}}}}});
  assert.equal((await generate({message:'pasted email',existing:[],evidence:[]})).length,2);assert.equal(calls.length,1);assert.deepEqual(calls[0].tools,[PROPOSE_GOVERNED_RECORDS_TOOL]);assert.equal(calls[0].tool_choice.name,'propose_governed_records');assert.equal(calls[0].parallel_tool_calls,false);assert.ok(calls[0].max_output_tokens<=6000);
});

test('preflight skips obvious questions and analysis but retains assertions and mixed input',()=>{
  for(const text of ['What do you know about Black Friday 2025?','Why did sales increase?','Compare 2024 with 2025.','When did the campaign run?']) assert.equal(needsProposalGeneration(text),false,text);
  for(const text of ['Our campaign ran in November.','Remember that our campaign ran in November.','Our campaign ran in November. Why did sales increase?']) assert.equal(needsProposalGeneration(text),true,text);
});

test('preflight avoids the OpenAI call and an empty structured response is successful',async()=>{
  let calls=0;const generate=createProposalGenerator({openai:{responses:{create:async()=>{calls++;return {output:[{type:'function_call',name:'propose_governed_records',arguments:'{"proposals":[]}'}]}}}}});
  assert.deepEqual(await generate({message:'Why did sales increase?'}),[]);assert.equal(calls,0);
  assert.deepEqual(await generate({message:'Our test campaign happened.'}),[]);assert.equal(calls,1);
});

test('ordinary stock-clearance briefs are eligible for proactive review proposals',()=>{
  for(const message of [
    'Danielle has asked us to clear stock on the listed products. Any ideas of what we can do? Use data where possible',
    'Danielle has asked us to clear stock on the listed products. What can we do about this? Please include data and sales info where appropriate.',
    'Danielle has asked us to look at clearing the following stock online: Large Anatomical Heart Ring, Small Anatomical Heart Ring, and Anatomical Heart Pendant.'
  ]) assert.equal(needsProposalGeneration(message),true,message);
});

test('product affinity requires explicit overlap or cross-sell intent',()=>{
  const danielle='Danielle has asked us to clear Large Anatomical Heart Ring, Small Anatomical Heart Ring, and Anatomical Heart Pendant online. Any ideas? Use data where possible.';
  assert.equal(affinityJustified(danielle),false);
  assert.equal(affinityJustified('What did customers also buy with the Chunky Hoop Earring?'),true);
  assert.equal(affinityJustified('Recommend cross-sell products using customer overlap'),true);
});

test('request IDs and terminal messages are bounded and safe',()=>{
  assert.equal(requestId('danielle-123'),'danielle-123');
  assert.match(requestId('customer name=Danielle / SQL'),/^[0-9a-f-]{36}$/);
  assert.match(terminalMessage('response_generation'),/final answer could not be generated/);
  assert.doesNotMatch(terminalMessage('response_generation'),/SQL|customer/i);
});

test('safe proposal diagnostics distinguish API failures without secrets or payloads',async()=>{
  const generate=createProposalGenerator({openai:{responses:{create:async()=>{const error=new Error('invalid schema sk-secret payload={"user_message":"private document"}');error.status=400;error.code='invalid_function_parameters';error.type='invalid_request_error';throw error;}}}});
  let caught;try{await generate({message:'Our campaign happened.'})}catch(error){caught=error}
  const diagnostic=proposalDiagnostic(caught,'gpt-5.6');assert.equal(diagnostic.phase,'openai_request');assert.equal(diagnostic.http_status,400);assert.equal(diagnostic.openai_code,'invalid_function_parameters');assert.doesNotMatch(JSON.stringify(diagnostic),/sk-secret/);assert.doesNotMatch(JSON.stringify(diagnostic),/private document/);
  assert.equal(caught.cause,undefined);assert.doesNotMatch(JSON.stringify(caught),/private document/);
});

test('production proposal diagnostic cannot invoke persistence or approval endpoints',async()=>{
  const source=await readFile(new URL('../diagnostics/oracle-proposals-production.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/writeRecord|\/approve|knowledge\/admin/);
});

function event(title,from,to,description,extra={}){return {kind:'event',event_type:'campaign',title,description,date_precision:from===to?'day':'range',effective_from:from,effective_to:to,status:'confirmed',source_type:'business_document',source_reference:'Black Friday 2024 campaign email supplied by authenticated administrator',tags:['black-friday'],supersedes:null,...extra}}
function fact(subject,statement,extra={}){return {kind:'fact',subject,predicate:'states',statement,effective_from:null,effective_to:null,status:'confirmed',source_type:'human_entered',source_reference:'Authenticated administrator assertion',tags:[],supersedes:null,...extra}}

const blackFridayCandidates=[
  event('Black Friday 2024 campaign','2024-11-07','2024-11-10','Campaign offer: 925 sterling silver 20% off; eye jewellery 15%; music collaborations 20%; enamel and stone rings 10%; clothing 20%. Exclusions: gold, wedding, other collaboration pieces and collaboration clothing, leather goods, selected newly released items, and selected earrings.'),
  event('Black Friday 2024 online sale','2024-11-08','2024-11-10','Online sale ran from 08:00 GMT on 8 November through midnight GMT on 10 November.'),
  event('Black Friday 2024 at TGF Soho','2024-11-07','2024-11-07','TGF Soho participated from 12:00 to 20:00.'),
  event('Black Friday 2024 at TGF East','2024-11-09','2024-11-09','TGF East participated from 10:30 to 18:30.'),
  fact('Made-to-order Christmas gifts','Sunday 10 November 2024 was the final order date for made-to-order jewellery intended as Christmas gifts.',{effective_from:'2024-11-10',effective_to:'2024-11-10',source_type:'business_document',source_reference:'Black Friday 2024 campaign email supplied by authenticated administrator',tags:['black-friday','made-to-order']})
];

test('synthetic Black Friday email yields comprehensive independently validated non-persistent records',async t=>{const f=await fixture(async()=>blackFridayCandidates);t.after(()=>f.server.close());const auth=await login(f.request,f.base);const headers={cookie:auth.cookie,origin:new URL(f.base).origin,'content-type':'application/json','x-csrf-token':auth.csrf};const response=await f.request('/chat',{method:'POST',headers,body:JSON.stringify({message:'Save the following campaign email as governed knowledge.'})});const body=await response.json();assert.equal(response.status,200);assert.ok(body.proposals.length>1);const text=JSON.stringify(body.proposals);for(const expected of ['2024-11-07','2024-11-08','2024-11-09','2024-11-10','12:00','10:30','925 sterling silver 20%','eye jewellery 15%','music collaborations 20%','enamel and stone rings 10%','clothing 20%','Exclusions','final order date'])assert.match(text,new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i'));assert.equal(f.writes.length,0);for(const p of body.proposals){assert.equal(p.persisted,false);assert.equal(p.saveable,true);assert.ok((p.proposal.title||p.proposal.subject).length<100);}});

test('questions and conversation can return zero proposals while declarative assertions can return one',async()=>{const inputs=[];const generate=async({message})=>{inputs.push(message);return message.startsWith('Our Shopify')?[event('Shopify site launch','2025-09-05','2025-09-05','The Shopify site launched.')]:[]};const f=await fixture(generate);try{const auth=await login(f.request,f.base);const headers={cookie:auth.cookie,origin:new URL(f.base).origin,'content-type':'application/json','x-csrf-token':auth.csrf};for(const message of ['What do you know about Black Friday 2025?','Why did November sales rise?','Compare Black Friday 2024 and 2025.','Hello there']){const body=await (await f.request('/chat',{method:'POST',headers,body:JSON.stringify({message})})).json();assert.deepEqual(body.proposals,[])}const body=await (await f.request('/chat',{method:'POST',headers,body:JSON.stringify({message:'Our Shopify site launched on 5 September 2025.'})})).json();assert.equal(body.proposals.length,1);assert.equal(f.writes.length,0)}finally{f.server.close()}});

test('uncertainty, duplicate, 2025 context, and memory governance are preserved',()=>{const uncertain=normalizeModelProposal({kind:'memory',memory_type:'hypothesis',title:'Possible sale start',statement:'The sale possibly started Thursday; this is not certain.',confidence:.3,evidence:[{kind:'user_attestation',reference:'Authenticated administrator assertion'}],effective_from:null,effective_to:null,status:'working',source_type:'human_entered',source_reference:'Authenticated administrator assertion',tags:[],supersedes:null});assert.equal(uncertain.proposal.status,'working');assert.throws(()=>normalizeModelProposal({...fact('Sale','Maybe Thursday'),status:'confirmed',surprise:'x'}),/invalid proposal field/);const duplicate=normalizeModelProposal(event('Known event','2025-01-01','2025-01-01','Same governed description'),{existing:[{id:'ev_1234567890abcdef',status:'confirmed',description:'Same governed description'}]});assert.equal(duplicate.validity,'already_known');assert.equal(duplicate.saveable,false);const context=normalizeModelProposal(fact('Black Friday 2025 MTO delivery','The promotion took place after the final order date, so made-to-order purchases during the promotion were not offered for Christmas delivery.'));assert.doesNotMatch(context.proposal.statement,/caused|sales (?:rose|fell)/i);const memory=normalizeModelProposal({kind:'memory',memory_type:'finding',title:'Observed conversion finding',statement:'Governed analysis found conversion increased.',confidence:.9,evidence:[{kind:'governed_query',reference:'query-result-2026-09-21'}],effective_from:null,effective_to:null,status:'confirmed',source_type:'governed_data_analysis',source_reference:'Governed analysis query-result-2026-09-21',tags:[],supersedes:null});assert.equal(memory.proposal.status,'confirmed');assert.throws(()=>normalizeModelProposal({...memory.proposal,kind:'memory',id:undefined,evidence:[]}),/evidence is required/)});

test('repeated briefs suppress duplicate cards while changed claims become linked reviewable updates',async t=>{
  const existing={id:'kn_1234567890abcdef',kind:'fact',title:'Danielle stock-clearance brief',content:'Danielle asked us to clear the three Anatomical Heart products online.',status:'confirmed'};
  const danielleBrief='Danielle has asked us to look at clearing the following stock online: Large Anatomical Heart Ring, Small Anatomical Heart Ring, and Anatomical Heart Pendant. Any ideas of what we can do? Use data where possible.';
  const candidate=statement=>fact('Danielle stock-clearance brief',statement);
  const generated=[];const generateProposals=async({message,existing:found})=>{generated.push({message,found});return [candidate(message.includes('New detail')?'Danielle asked us to clear the three Anatomical Heart products online, with pendants prioritised.':existing.content)]};
  const writes=[],bigquery={dataset:()=>({table:()=>({insert:async rows=>writes.push(...rows)})}),query:async()=>[[]]},knowledgeService={searchKnowledge:async()=>({items:[existing]}),searchMemory:async()=>({items:[]})};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService,bigquery,project:'test',chat:async()=>({answer:'advice',tools:[]}),generateProposals,env}));
  const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`,request=(path,options={})=>fetch(base+path,options),auth=await login(request,base),headers={cookie:auth.cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf};
  const repeated=await (await request('/chat',{method:'POST',headers,body:JSON.stringify({message:danielleBrief})})).json();assert.deepEqual(repeated.proposals,[]);
  const changed=await (await request('/chat',{method:'POST',headers,body:JSON.stringify({message:'New detail: prioritise pendants in Danielle’s stock-clearance brief.'})})).json();assert.equal(changed.proposals.length,1);assert.equal(changed.proposals[0].proposal.supersedes,existing.id);assert.equal(changed.proposals[0].saveable,true);assert.equal(changed.proposals[0].persisted,false);assert.equal(writes.length,0);assert.equal(generated.length,2);assert.deepEqual(generated[0].found,[existing]);
});

test('proposal failure does not discard the normal chat answer or expose errors',async t=>{const f=await fixture(async()=>{throw new Error('secret upstream failure')});t.after(()=>f.server.close());const auth=await login(f.request,f.base);const headers={cookie:auth.cookie,origin:new URL(f.base).origin,'content-type':'application/json','x-csrf-token':auth.csrf};const response=await f.request('/chat',{method:'POST',headers,body:'{"message":"Our store opened."}'});const body=await response.json();assert.equal(response.status,200);assert.equal(body.answer,'answer:Our store opened.');assert.equal(body.proposal_error,'Knowledge proposal could not be generated.');assert.doesNotMatch(JSON.stringify(body),/secret upstream/) });

test('Danielle request preserves completed affinity evidence when a later synthesis fails and suppresses duplicate proposals',async t=>{
  const danielle='Danielle has asked us to look at clearing the following stock online: Large Anatomical Heart Ring, Small Anatomical Heart Ring, and Anatomical Heart Pendant. Any ideas of what we can do? Use data where possible.';
  const queryEvents=[];
  const bigquery={query:async({label})=>{queryEvents.push(label);return [[]]}};
  const chat=async message=>{
    await Promise.all([bigquery.query({label:'product_affinity_primary'}),bigquery.query({label:'product_affinity_guest'})]);
    const laterError=new Error('secret provider failure after completed queries');
    assert.equal(laterError.constructor.name,'Error');
    return {answer:partialAnswer(message,['get_shopify_customer_product_behavior'],['final_synthesis']),tools:['get_shopify_customer_product_behavior'],partial:true};
  };
  const existing={id:'kn_1234567890abcdef',kind:'fact',title:'Danielle stock-clearance brief',content:'Danielle asked us to clear the three Anatomical Heart products online.',status:'confirmed'};
  let proposalCalls=0;
  const knowledgeService={searchKnowledge:async()=>({items:[existing]}),searchMemory:async()=>({items:[]})};
  const generateProposals=async()=>{proposalCalls++;return [fact('Danielle stock-clearance brief',existing.content)]};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService,bigquery,project:'test',chat,generateProposals,env}));
  const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`,request=(path,options={})=>fetch(base+path,options),auth=await login(request,base);
  const response=await request('/chat',{method:'POST',headers:{cookie:auth.cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf,'x-request-id':'danielle-e2e'},body:JSON.stringify({message:danielle})});
  const body=await response.json();
  assert.equal(response.status,200);assert.equal(response.headers.get('x-request-id'),'danielle-e2e');
  assert.deepEqual(queryEvents,['product_affinity_primary','product_affinity_guest']);
  assert.match(body.answer,/Governed evidence completed/);assert.match(body.answer,/time-boxed/);assert.doesNotMatch(body.answer,/secret provider|customer_name|SELECT/i);
  assert.deepEqual(body.proposals,[]);assert.equal(proposalCalls,1);
});

test('agent transport failure terminates with a specific bounded error',async t=>{const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'test',chat:async()=>{const error=new Error('socket secret');error.name='TimeoutError';throw error},env}));const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`,request=(path,options={})=>fetch(base+path,options),auth=await login(request,base);const response=await request('/chat',{method:'POST',headers:{cookie:auth.cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf},body:'{"message":"Danielle stock clearance"}'}),body=await response.json();assert.equal(response.status,504);assert.equal(body.code,'ORACLE_AGENT_DEADLINE');assert.match(body.error,/did not return before the request deadline/);assert.doesNotMatch(JSON.stringify(body),/socket secret/)});

test('production customer behavior diagnostics never log SQL or parameter payloads',async()=>{const source=await readFile(new URL('../server.js',import.meta.url),'utf8');const block=source.slice(source.indexOf("Shopify customer/product behavior query planned"),source.indexOf('const runBigQuery',source.indexOf("Shopify customer/product behavior query planned")));assert.doesNotMatch(block,/\bsql\s*[,}:]/i);assert.doesNotMatch(block,/\bparams\s*[,}:]/i);assert.match(block,/parameter_names/)});
test('redacts Google bearer tokens and credential-shaped fields',()=>{const output=redactError({headers:{authorization:'Bearer ya29.secret-token'},private_key:'abc'});assert.doesNotMatch(output,/ya29|abc/);assert.match(output,/REDACTED/)});
test('UI APIs require a session, CSRF and same origin while chat reuses injected agent',async t=>{const f=await fixture();t.after(()=>f.server.close());assert.equal((await f.request('/knowledge')).status,401);assert.equal((await f.request('/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:'{"password":"test-password"}'})).status,403);const auth=await login(f.request,f.base);const headers={cookie:auth.cookie,origin:new URL(f.base).origin,'content-type':'application/json','x-csrf-token':auth.csrf};assert.equal((await f.request('/chat',{method:'POST',headers:{...headers,'x-csrf-token':'bad'},body:'{"message":"hello"}'})).status,403);const response=await f.request('/chat',{method:'POST',headers,body:'{"message":"hello"}'});assert.equal(response.status,200);assert.equal((await response.json()).answer,'answer:hello');assert.equal(f.writes.length,0)});
test('choice preview is authenticated, read-only, bounded and safely reports failures',async t=>{const calls=[];const service={previewChoice:async(candidate,selected)=>{calls.push([candidate,selected]);if(selected==='fail')throw new Error('secret warehouse detail');return{read_only:true,selected_product:{source_product_ref:selected}}}};const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'test',chat:async()=>({answer:''}),productMappingService:service,env}));const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`,request=(path,options={})=>fetch(base+path,options);assert.equal((await request('/product-mappings/choice-preview?candidate_id=x&selected_ref=y')).status,401);const auth=await login(request,base),headers={cookie:auth.cookie};const good=await request('/product-mappings/choice-preview?candidate_id=aaaaaaaaaaaaaaaaaaaaaaaa&selected_ref=shopify%3Ashopify%3A1',{headers});assert.equal(good.status,200);assert.deepEqual(calls[0],['aaaaaaaaaaaaaaaaaaaaaaaa','shopify:shopify:1']);const failed=await request('/product-mappings/choice-preview?candidate_id=aaaaaaaaaaaaaaaaaaaaaaaa&selected_ref=fail',{headers}),body=await failed.json();assert.equal(failed.status,503);assert.doesNotMatch(JSON.stringify(body),/secret warehouse detail/)});

test('product mapping read has a bounded request id and safe stage-aware failure',async t=>{const service={list:async()=>{const error=new Error('secret customer detail in SQL');error.stage='load_products';error.queryOperation='product_mapping_products';throw error}};const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'test',chat:async()=>({answer:''}),productMappingService:service,env}));const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`,request=(path,options={})=>fetch(base+path,options),auth=await login(request,base);const response=await request('/product-mappings?search=',{headers:{cookie:auth.cookie,'x-request-id':'review-123'}}),body=await response.json();assert.equal(response.status,503);assert.equal(response.headers.get('x-request-id'),'review-123');assert.equal(body.request_id,'review-123');assert.equal(body.error,'The request could not be completed');assert.doesNotMatch(JSON.stringify(body),/secret|SQL/)});

test('picker preview invalidates stale selections and failures keep both confirmations disabled',async()=>{const source=await readFile(new URL('../public/oracle/app.js',import.meta.url),'utf8');assert.match(source,/request!==previewRequest\|\|pickerSelection!==product/);assert.match(source,/Preview unavailable:/);assert.match(source,/\$\('#mapping-confirm'\)\.disabled=true;\$\('#family-confirm'\)\.disabled=true/);assert.match(source,/choicePreview\.selected_product\.source_product_ref!==pickerSelection\.source_product_ref/g)});
test('collection writes use the authenticated CSRF contract and existing classify/revoke routes',async t=>{const calls=[];const service={classify:async(input,user)=>{calls.push(['classify',input,user]);return {group:{classification_id:'cc1'}}},revoke:async(input,user)=>{calls.push(['revoke',input,user]);return {revoked:true}}};const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'test',chat:async()=>({answer:''}),collectionClassificationService:service,env}));const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`,request=(path,options={})=>fetch(base+path,options),auth=await login(request,base),body=JSON.stringify({collection_id:'123',collection_title:'Sammi',collection_group:'collaboration',collaboration_name:'Sammi',note:null}),valid={cookie:auth.cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf};assert.equal((await request('/collection-classifications/classify',{method:'POST',headers:{...valid,'x-csrf-token':'bad'},body})).status,403);assert.equal((await request('/collection-classifications/classify',{method:'POST',headers:valid,body})).status,201);assert.deepEqual(calls[0],['classify',JSON.parse(body),'test-admin']);assert.equal((await request('/collection-classifications/revoke',{method:'POST',headers:valid,body:'{"classification_id":"cc1"}'})).status,200);assert.equal((await request('/collection-classifications/classify',{method:'POST',headers:{origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf},body})).status,401)});
test('explicit approval writes only a whitelisted validated schema',async t=>{const f=await fixture();t.after(()=>f.server.close());const auth=await login(f.request,f.base);const headers={cookie:auth.cookie,origin:new URL(f.base).origin,'content-type':'application/json','x-csrf-token':auth.csrf};const bad=await f.request('/knowledge/approve',{method:'POST',headers,body:JSON.stringify({kind:'arbitrary_table',proposal:{}})});assert.equal(bad.status,400);const proposal=normalizeModelProposal({kind:'event',event_type:'launch',title:'Shopify launch',description:'The site launched.',date_precision:'day',effective_from:'2026-01-02',effective_to:'2026-01-02',status:'confirmed',source_type:'human_entered',source_reference:'Authenticated administrator assertion',tags:[],supersedes:null});const saved=await f.request('/knowledge/approve',{method:'POST',headers,body:JSON.stringify({kind:proposal.kind,proposal:proposal.proposal})});assert.equal(saved.status,201);assert.equal(f.writes.length,1)});
test('UI knowledge and memory browsing normalize absent filters as inactive',async t=>{const f=await fixture();t.after(()=>f.server.close());const auth=await login(f.request,f.base);const headers={cookie:auth.cookie};assert.equal((await f.request('/knowledge',{headers})).status,200);assert.equal((await f.request('/memory',{headers})).status,200);assert.deepEqual(f.browse,[{tool:'knowledge',input:{text:null,start_date:null,end_date:null,status:null,tags:[],limit:20,knowledge_type:null}},{tool:'memory',input:{text:null,start_date:null,end_date:null,status:null,tags:[],limit:20,memory_type:null}}])});

test('UI terminates throttled chat with a safe inventory-specific response',async t=>{const error=new ShopifyThrottleError(undefined,{requested_query_cost:1000,currently_available:779,reset_at:'2026-09-24T17:14:00+00:00'});const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'test',chat:async()=>{throw error},env}));const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`,request=(path,options={})=>fetch(base+path,options),auth=await login(request,base);const response=await request('/chat',{method:'POST',headers:{cookie:auth.cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf},body:'{"message":"follow up on stock clearance"}'}),body=await response.json();assert.equal(response.status,429);assert.equal(body.error,SHOPIFY_RATE_LIMIT_MESSAGE);assert.equal(body.code,'SHOPIFY_TEMPORARILY_RATE_LIMITED');assert.doesNotMatch(JSON.stringify(body),/1000|779|windowResetAt|upstream/)});

test('successful follow-up receives bounded recent governed evidence with freshness',async t=>{const calls=[];let clock=Date.parse('2026-09-24T17:00:00Z');const chat=async(message,conversation)=>{calls.push({message,conversation});return {answer:calls.length===1?'Soho has governed stock evidence.':'Follow-up used that evidence.',tools:['get_shopify_inventory_by_location']}};const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'test',chat,env,now:()=>clock}));const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});t.after(()=>server.close());const base=`http://127.0.0.1:${server.address().port}/api/oracle`,request=(path,options={})=>fetch(base+path,options),auth=await login(request,base),headers={cookie:auth.cookie,origin:new URL(base).origin,'content-type':'application/json','x-csrf-token':auth.csrf};assert.equal((await request('/chat',{method:'POST',headers,body:'{"message":"check Soho stock"}'})).status,200);clock+=60_000;const response=await request('/chat',{method:'POST',headers,body:'{"message":"what should Danielle do next?"}'});assert.equal(response.status,200);assert.equal(calls.length,2);assert.equal(calls[1].conversation.recentEvidence.as_of,'2026-09-24T17:00:00.000Z');assert.match(calls[1].conversation.recentEvidence.answer,/Soho/);assert.deepEqual(calls[1].conversation.recentEvidence.tools,['get_shopify_inventory_by_location'])});

import {stockAnswer} from './current-stock.js';
import { withOracleCharts } from './evidence-charts.js';
import { presentAnalyticalAnswer } from './answer-presentation.js';
import { productReportConfigKey } from './product-report-config.js';
import { exportOwnerKey, priorityArtifactId, sendPriorityDownload } from './product-priority-storage.js';
import crypto from 'node:crypto';
import express from 'express';
import { writeRecord } from '../knowledge/admin.js';
import { invalidProposal, needsProposalGeneration, normalizeModelProposal, proposalDiagnostic, validateApprovedProposal } from './proposals.js';
import { createSession, csrfToken, parseCookies, safeError, verifySession } from './ui-security.js';
import { reportCsv, reportPdf, reportWorkbook } from './report-export.js';
import { analysisScope, clarificationFor, emptyAnalysisContext, transitionAnalysisContext } from './analysis-context.js';
import { governanceDiagnostic, governancePublicError, isGovernanceBusinessError } from './governance-diagnostics.js';
import { SHOPIFY_RATE_LIMIT_MESSAGE } from './shopifyql-throttle.js';
import { requestId, serverFailureDiagnostic, stageOutcome, terminalMessage, transportFailure } from './request-observability.js';
import { createAnalysisJobWorker, ownerKey, streamingInsertDiagnostic } from './analysis-jobs.js';
import { campaignDateClarification, resolveKnowledgeDates } from './knowledge-dates.js';
import { assertEvidenceAgreement, dispatchAnalysisRequest } from './analysis-route-dispatcher.js';

const json = express.json({ limit: '48kb', type: 'application/json' });
const messageError = body => {
  if (body && typeof body === 'object' && typeof body.message !== 'string' && ['prompt', 'question', 'query'].some(key => typeof body[key] === 'string')) return { status: 409, code: 'ORACLE_CLIENT_UPDATE_REQUIRED', error: 'This Oracle client is out of date. Refresh the page and submit again.' };
  if (typeof body?.message !== 'string' || !body.message.trim() || body.message.length > 12000) return { status: 422, code: 'INVALID_MESSAGE', error: 'message must be a non-empty string of at most 12000 characters' };
  return null;
};
const allowedOrigins = request => new Set([`${request.protocol}://${request.get('host')}`, process.env.ORACLE_UI_ORIGIN].filter(Boolean));

export function createOracleUiRouter({ knowledgeService, bigquery, project, chat, baselineOverview=null, generateProposals, reportService, productMappingService, collectionClassificationService, analysisJobStore, exportStore, env = process.env, now = () => Date.now() }) {
  const router = express.Router();
  const password = env.ORACLE_UI_PASSWORD;
  const sessionSecret = env.ORACLE_UI_SESSION_SECRET;
  const proposalModel = env.ORACLE_PROPOSAL_MODEL || 'gpt-5.6';
  const analysisSessions = new Map();
  const recentChatEvidence = new Map();
  const unansweredIntents = new Map();
  const scopeGenerations = new Map();
  const logProposalError = error => console.error('Oracle UI proposal generation failed:', proposalDiagnostic(error, proposalModel));
  const mappingReadDiagnostic=(error,context)=>{const value=governanceDiagnostic(error,context);delete value.internal_message;return value};
  const mappingLimit=Math.max(1,Math.min(Number(env.ORACLE_MAPPING_CONCURRENCY)||1,2));
  const mappingQueueLimit=Math.max(0,Math.min(Number(env.ORACLE_MAPPING_QUEUE_LIMIT)||2,10));
  let activeMappingReads=0;const mappingWaiters=[];
  router.use((req,res,next)=>{req.oracleRequestId=requestId(req.get('x-request-id'));req.oracleFailureStage='request_dispatch';res.setHeader('x-request-id',req.oracleRequestId);next();});
  const acquireMappingRead=req=>new Promise((resolve,reject)=>{
    if(activeMappingReads<mappingLimit){activeMappingReads++;return resolve();}
    if(mappingWaiters.length>=mappingQueueLimit)return reject(Object.assign(new Error('Product mapping is busy; retry shortly.'),{code:'MAPPING_BUSY'}));
    const waiter={resolve:()=>{activeMappingReads++;resolve();},reject};mappingWaiters.push(waiter);
    req.once('aborted',()=>{const index=mappingWaiters.indexOf(waiter);if(index>=0){mappingWaiters.splice(index,1);reject(Object.assign(new Error('mapping request cancelled'),{code:'ABORT_ERR'}));}});
  });
  const releaseMappingRead=()=>{activeMappingReads--;mappingWaiters.shift()?.resolve();};
  if (!password || !sessionSecret || sessionSecret.length < 32) throw new Error('ORACLE_UI_PASSWORD and ORACLE_UI_SESSION_SECRET (32+ characters) are required');
  const authenticate = (req, res, next) => {
    const session = verifySession(parseCookies(req.headers.cookie).oracle_session, sessionSecret);
    if (!session) return res.status(401).json({ success: false, error: 'Authentication required' });
    req.oracleUser = session; next();
  };
  const protectWrite = (req, res, next) => {
    if (!allowedOrigins(req).has(req.get('origin'))) return res.status(403).json({ success: false, error: 'Invalid request origin' });
    const cookies = parseCookies(req.headers.cookie);
    if (!cookies.oracle_csrf || req.get('x-csrf-token') !== cookies.oracle_csrf) return res.status(403).json({ success: false, error: 'Invalid CSRF token' });
    if (!req.is('application/json')) return res.status(415).json({ success: false, error: 'application/json is required' });
    next();
  };
  const proposalsFor = async (message, createdBy, suppliedTemporalContext=null) => {
    if (!needsProposalGeneration(message)) return [];
    if (!generateProposals) throw new Error('proposal generator unavailable');
    let existing = [];
    try {
      const [knowledge, memory] = await Promise.all([
        knowledgeService.searchKnowledge({ text: null, knowledge_type: null, start_date: null, end_date: null, status: null, tags: [], limit: 50 }),
        knowledgeService.searchMemory({ text: null, start_date: null, end_date: null, status: null, memory_type: null, tags: [], limit: 50 })
      ]);
      existing = [...(knowledge.items || []), ...(memory.items || [])];
    } catch (error) { console.error('Oracle UI proposal context lookup failed:', safeError(error)); }
    const temporalContext=suppliedTemporalContext||resolveKnowledgeDates(message,{timestamp:now(),timeZone:'Europe/London'});
    const candidates = await generateProposals({ message, existing, evidence: [], temporalContext });
    return candidates.slice(0, 12).map(candidate => {
      try {
        if(temporalContext&&!temporalContext.ambiguous&&candidate.kind==='event'&&/campaign|marketing|promotion|social/i.test(`${candidate.event_type} ${candidate.title} ${candidate.description}`))candidate={...candidate,effective_from:temporalContext.effective_start,effective_to:temporalContext.effective_end,date_precision:temporalContext.precision};
        const wrapper=normalizeModelProposal(candidate, { createdBy, existing });
        return temporalContext&&!temporalContext.ambiguous?{...wrapper,date_resolution:{original_wording:temporalContext.original_wording,effective_start:temporalContext.effective_start,effective_end:temporalContext.effective_end,time_zone:temporalContext.time_zone,message_timestamp:temporalContext.message_timestamp}}:wrapper;
      }
      catch (error) { error.phase = 'proposal_validation'; logProposalError(error); return invalidProposal(candidate); }
    }).filter(proposal => proposal.validity !== 'already_known');
  };
  router.post('/auth/login', json, (req, res) => {
    if (!allowedOrigins(req).has(req.get('origin'))) return res.status(403).json({ success: false, error: 'Invalid request origin' });
    const supplied = Buffer.from(String(req.body?.password || ''));
    const expected = Buffer.from(password);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.status(401).json({ success: false, error: 'Invalid credentials' });
    const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
    const csrf = csrfToken();
    res.setHeader('Set-Cookie', [`oracle_session=${createSession(env.ORACLE_UI_ADMIN_NAME || 'oracle-admin', sessionSecret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure}`, `oracle_csrf=${csrf}; Path=/; SameSite=Strict; Max-Age=28800${secure}`]);
    res.json({ success: true, csrf, user: env.ORACLE_UI_ADMIN_NAME || 'oracle-admin' });
  });
  const sessionKey=req=>crypto.createHash('sha256').update(parseCookies(req.headers.cookie).oracle_session||'').digest('hex');
  const sessionContext=req=>{const key=sessionKey(req),entry=analysisSessions.get(key);if(!entry||entry.expires_at<=Date.now()){analysisSessions.delete(key);return emptyAnalysisContext()}return entry.context};
  const saveSessionContext=(req,context)=>analysisSessions.set(sessionKey(req),{context,expires_at:req.oracleUser.exp*1000});
  const contextWithProductEvidence=(context,evidence)=>{if(context?.requested_subject==='current_stock'&&evidence?.entity_query===context.entity_query){return {...context,pending_product_candidates:(evidence.candidates||[]).slice(0,8).map(c=>({product_ref:c.id,catalogue_titles:[c.title],sources:[],reporting_family_relationships:[]}))};}if(context?.requested_subject!=='product_sales'||evidence?.entity_query!==context.entity_query)return context;const next={...context};if(evidence?.candidates?.length)next.pending_product_candidates=evidence.candidates;if(evidence?.resolved_product_ref)next.product_ref=evidence.resolved_product_ref;return next};
  const restoreReportContext=(req,evidence,scopeGeneration='initial')=>{if(generation(req)!==scopeGeneration||sessionContext(req).requested_subject||!evidence?.report_config)return;const c=evidence.report_config;saveSessionContext(req,{...emptyAnalysisContext(),analysis_type:'products',metrics:['products'],requested_subject:c.priority_preset?'product_priority':'product_report',tool_route:'export_product_priorities',channel:c.channel,platform:'shopify',output_preference:c.output_format,start_date:c.period.start_date,end_date:c.period.end_date,limit:c.population.limit,product_report:c});};
  const generation=req=>scopeGenerations.get(sessionKey(req))||parseCookies(req.headers.cookie).oracle_scope_generation||'initial';
  const clearAnalysis=(req,res)=>{const key=sessionKey(req);analysisSessions.delete(key);recentChatEvidence.delete(key);unansweredIntents.delete(key);const value=crypto.randomUUID();scopeGenerations.set(key,value);res?.setHeader('Set-Cookie',`oracle_scope_generation=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${env.NODE_ENV==='production'?'; Secure':''}`);};
  const currentJobScope=(req,job)=>generation(req)===(job.payload_json?.scope_generation||'initial');
  const relevantEvidence=(cached,context)=>{if(!cached||cached.expires_at<=now()||!cached.value.evidence)return null;try{assertEvidenceAgreement(context,cached.value.evidence);if(!context?.requested_subject)return null;return cached.value;}catch{return null;}};
  const exportOwner=req=>exportOwnerKey(req.oracleUser.sub,sessionSecret);
  if(exportStore) router.get('/exports/:id',authenticate,async(req,res,next)=>{try{await sendPriorityDownload(exportStore,req.params.id,exportOwner(req),res);}catch(error){next(error)}});
  if(exportStore) router.get('/exports/:id/manifest',authenticate,async(req,res,next)=>{try{if(!/^[a-f0-9]{64}$/.test(req.params.id))return res.status(404).json({success:false,error:'Export not found'});const saved=await exportStore.get(req.params.id,exportOwner(req));if(!saved)return res.status(404).json({success:false,error:'Export not found'});if(req.query.report_config){let expected;try{expected=JSON.parse(req.query.report_config);if(!saved.envelope.report_config||productReportConfigKey(expected)!==productReportConfigKey(saved.envelope.report_config))throw new Error('mismatch');}catch{return res.status(409).json({success:false,code:'EXPORT_CONFIGURATION_MISMATCH',error:'The saved export does not match the requested report configuration.'});}restoreReportContext(req,saved.envelope,req.query.scope_generation||'initial');}res.setHeader('Cache-Control','private, no-store');res.json({success:true,scope_generation:generation(req),...presentAnalyticalAnswer({answer:saved.answer,evidence:saved.envelope}),charts:saved.envelope.chart_specs||[],inline_chart:saved.envelope.chart_specs?.[0]||null,artifact:{id:req.params.id,filename:saved.filename,row_count:saved.envelope.rows.length,download_url:`/api/oracle/exports/${req.params.id}`}});}catch(error){next(error)}});
  router.post('/auth/logout', authenticate, protectWrite, (req, res) => { const key=sessionKey(req);analysisSessions.delete(key);recentChatEvidence.delete(key);unansweredIntents.delete(key);res.setHeader('Set-Cookie', ['oracle_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0', 'oracle_csrf=; Path=/; SameSite=Strict; Max-Age=0']); res.json({ success: true }); });
  router.get('/session', authenticate, (req, res) => res.json({ success: true, user: req.oracleUser.sub, role: req.oracleUser.role, analysis_scope:analysisScope(sessionContext(req)), scope_generation:generation(req), deep_analysis_enabled:Boolean(analysisJobStore&&env.ORACLE_ANALYSIS_JOBS_ENABLED==='true') }));
  router.post('/analysis/clear',authenticate,protectWrite,json,(req,res)=>{clearAnalysis(req,res);res.json({success:true,analysis_scope:null,scope_generation:generation(req)})});
  // Durable jobs remain opt-in until the production-shaped enqueue/claim/finish/poll
  // diagnostic has passed. Interactive chat must never depend on queue health.
  if (analysisJobStore && env.ORACLE_ANALYSIS_JOBS_ENABLED === 'true') {
    const worker=createAnalysisJobWorker({store:analysisJobStore,runtimeMs:Number(env.ORACLE_JOB_RUNTIME_MS)||8*60_000,run:async(job,signal)=>{
      const input=job.payload_json;
      const correlation={request_id:job.request_id,job_id:job.job_id,attempt:Number(job.attempts)||0};
      const onProviderStage=event=>console.info('Oracle durable provider stage:',{...correlation,...event});
      const answer=await dispatchAnalysisRequest({message:input.message,analysisContext:input.analysis_context,baselineOverview,baselineOptions:{onProviderStage,exportOwner:input.export_owner,requestId:job.request_id,signal,deadlineAt:Date.now()+(Number(env.ORACLE_JOB_RUNTIME_MS)||480_000)-2000,onEvidence:async answer=>{if(await analysisJobStore.checkpoint(job.job_id,{success:true,...answer},job)===false)throw Object.assign(new Error('Lease rejected'),{code:'LEASE_NOT_OWNED'});}},chat,chatOptions:{analysisContext:input.analysis_context,transition:input.transition,recentEvidence:input.recent_evidence,requestId:job.request_id,jobId:job.job_id,attempt:Number(job.attempts)||0,signal,durable:true}});
      let proposals=[],proposal_error=null;
      try { proposals=answer.artifact?[]:await proposalsFor(input.message,input.created_by,input.temporal_context); } catch(error) { logProposalError(error);proposal_error='Knowledge proposal could not be generated.'; }
      return {success:true,analysis_context:answer.analysis_context||null,answer:answer.answer,presentation:answer.presentation||null,evidence:answer.evidence||null,inline_chart:answer.inline_chart||null,charts:answer.charts||answer.evidence?.chart_specs||[],artifact:answer.artifact||null,proposals,proposal_error,analysis_scope:analysisScope(input.analysis_context),tools:(answer.tools||[]).slice(0,20)};
    }});
    const jobStoreReady=analysisJobStore.setup();
    jobStoreReady.then(()=>worker.start()).catch(error=>console.error('Oracle job storage setup failed:',{error_class:error?.name||'Error'}));
    const owned=(req,id)=>analysisJobStore.get(id,ownerKey(parseCookies(req.headers.cookie).oracle_session,sessionSecret));
    router.post('/jobs',authenticate,protectWrite,json,async(req,res)=>{
      const id=req.oracleRequestId;
      req.oracleFailureStage='job_storage_readiness';
      try { await jobStoreReady; } catch(error) { console.error('Oracle job submission failed:',serverFailureDiagnostic({id,path:req.originalUrl,stage:req.oracleFailureStage,error}));return res.status(503).json({success:false,code:'ORACLE_JOB_STORAGE_UNAVAILABLE',error:'Analysis job storage is unavailable. Ask an administrator to run the Oracle job-readiness check, then retry explicitly.',request_id:id}); }
      req.oracleFailureStage='job_request_validation';
      const invalid=messageError(req.body);if(invalid)return res.status(invalid.status).json({success:false,code:invalid.code,error:invalid.error,request_id:id});
      req.oracleFailureStage='job_context_resolution';
      if((req.body.new_question===true||/^(?:new (?:question|analysis)|forget that|start over)\b/i.test(req.body.message)))clearAnalysis(req,res);
      const previous=sessionContext(req),result=transitionAnalysisContext(previous,req.body.message,{now:now(),reportContext:req.body.report_context||null});
      if(result.transition.applies_to_message)saveSessionContext(req,result.context);
      const cached=recentChatEvidence.get(sessionKey(req)),recent=relevantEvidence(cached,result.context);
      const pending=result.context.requested_subject===previous.requested_subject?unansweredIntents.get(sessionKey(req)):null;
      const effectiveMessage=pending?`${pending.message}\n\nUser follow-up: ${req.body.message}`:req.body.message;
      const owner=ownerKey(parseCookies(req.headers.cookie).oracle_session,sessionSecret);
      console.info('Oracle route selection:',{request_id:id,stage:'route_selection',route:'durable_job',outcome:'selected'});
      let job;try{req.oracleFailureStage='job_idempotency_lookup';job=await analysisJobStore.getByRequest?.(id,owner);if(job&&((job.payload_json?.original_message||job.payload_json?.message)!==req.body.message||(result.context.product_report&&(!job.payload_json?.analysis_context?.product_report||productReportConfigKey(job.payload_json.analysis_context.product_report)!==productReportConfigKey(result.context.product_report))))){saveSessionContext(req,previous);return res.status(409).json({success:false,code:'ORACLE_REQUEST_ID_CONFLICT',error:'This correlation ID already belongs to a different analysis. Submit this request with a new correlation ID.',request_id:id});}if(!job){req.oracleFailureStage='job_creation';job=await analysisJobStore.create({owner_key:owner,request_id:id,payload_json:{scope_generation:generation(req),original_message:req.body.message,message:effectiveMessage,previous_analysis_context:previous,temporal_context:resolveKnowledgeDates(req.body.message,{timestamp:now(),timeZone:'Europe/London'}),analysis_context:result.transition.applies_to_message?result.context:null,transition:result.transition,recent_evidence:recent,created_by:req.oracleUser.sub,export_owner:exportOwner(req)}});}}catch(error){console.error('Oracle job enqueue failed:',{...serverFailureDiagnostic({id,path:req.originalUrl,stage:req.oracleFailureStage,error}),storage:streamingInsertDiagnostic(error)});return res.status(503).json({success:false,code:'ORACLE_JOB_ENQUEUE_FAILED',error:'The analysis could not be queued. Retry explicitly with the same correlation ID; Oracle will check for an existing job first.',request_id:id});}
      if(!job?.job_id){const error=Object.assign(new Error('job store returned no job identifier'),{code:'JOB_RESULT_INVALID'});console.error('Oracle job enqueue failed:',serverFailureDiagnostic({id,path:req.originalUrl,stage:'job_creation_result',error}));return res.status(503).json({success:false,code:'ORACLE_JOB_RESULT_INVALID',error:'The job store did not confirm submission. Retry explicitly with the same correlation ID.',request_id:id});}
      if(clarificationFor(result.context))unansweredIntents.set(sessionKey(req),{message:pending?.message||req.body.message});else unansweredIntents.delete(sessionKey(req));
      res.status(202).json({success:true,job_id:job.job_id,status:job.status||'queued',request_id:id});
    });
    router.get('/jobs/request/:requestId',authenticate,async(req,res,next)=>{try{req.oracleFailureStage='job_idempotency_lookup';const owner=ownerKey(parseCookies(req.headers.cookie).oracle_session,sessionSecret),job=await analysisJobStore.getByRequest?.(requestId(req.params.requestId),owner);if(!job)return res.status(404).json({success:false,code:'ANALYSIS_JOB_NOT_FOUND',error:'No analysis job was found for this correlation ID.',request_id:req.oracleRequestId});res.json({success:true,job_id:job.job_id,status:job.status,request_id:req.oracleRequestId});}catch(error){next(error)}});
    router.get('/jobs/:id',authenticate,async(req,res,next)=>{try{req.oracleFailureStage='job_status_lookup';const job=await owned(req,req.params.id);if(!job)return res.status(404).json({success:false,error:'Analysis job not found',request_id:req.oracleRequestId});if(exportStore&&job.status==='failed'&&job.payload_json?.analysis_context?.tool_route==='export_product_priorities'){const artifactId=priorityArtifactId(job.payload_json.export_owner,job.request_id),saved=await exportStore.get(artifactId,exportOwner(req));if(saved){assertEvidenceAgreement(job.payload_json.analysis_context,saved.envelope);if(currentJobScope(req,job))restoreReportContext(req,saved.envelope,job.payload_json?.scope_generation||'initial');return res.json({success:true,job_id:job.job_id,status:'completed',recovered_persisted_export:true,...presentAnalyticalAnswer({answer:saved.answer,evidence:saved.envelope},job.payload_json.analysis_context),charts:saved.envelope.chart_specs||[],inline_chart:saved.envelope.chart_specs?.[0]||null,artifact:{id:artifactId,filename:saved.filename,row_count:saved.envelope.rows.length,download_url:`/api/oracle/exports/${artifactId}`}});}}const publicJob={success:true,job_id:job.job_id,status:job.status,progress:job.status==='queued'?'Analysis queued':job.status==='running'?'Running governed analysis':job.status==='completed'?'Analysis complete':job.status==='cancelled'?'Analysis cancelled':'Analysis failed',request_id:job.request_id};const persistedResult=job.result_json&&typeof job.result_json==='object'&&job.result_json.answer?job.result_json:null;if(job.status==='completed'||persistedResult){assertEvidenceAgreement(job.result_json?.analysis_context||job.payload_json?.analysis_context,job.result_json?.evidence);const recoveredAnswer=job.result_json?.evidence?.kind==='governed_device_conversion'?presentAnalyticalAnswer(withOracleCharts(job.result_json),job.payload_json?.analysis_context):job.result_json;const {tools=[], ...result}=recoveredAnswer;if(result.evidence?.subject==='current_stock'){result.answer=stockAnswer(result.evidence);const split=result.answer.indexOf('<details>');result.presentation={...result.presentation,summary_markdown:split<0?result.answer:result.answer.slice(0,split).trim()};}Object.assign(publicJob,result);if(currentJobScope(req,job)){if(!sessionContext(req).requested_subject&&job.payload_json?.analysis_context)saveSessionContext(req,job.payload_json.analysis_context);if(result.analysis_context?.campaign_request&&sessionContext(req).requested_subject==='klaviyo_email'&&JSON.stringify(sessionContext(req).campaign_request)===JSON.stringify(job.payload_json?.analysis_context?.campaign_request))saveSessionContext(req,result.analysis_context);restoreReportContext(req,result.evidence,job.payload_json?.scope_generation||'initial');}if(currentJobScope(req,job)&&['product_sales','current_stock'].includes(result.evidence?.subject)){const context=sessionContext(req);if(context.requested_subject===result.evidence.subject&&context.entity_query===result.evidence.entity_query)saveSessionContext(req,contextWithProductEvidence(context,result.evidence));}if(persistedResult)publicJob.recovered_persisted_result=job.status!=='completed';if(currentJobScope(req,job))recentChatEvidence.set(sessionKey(req),{expires_at:now()+15*60*1000,value:{as_of:job.updated_at,answer:String(result.answer||'').slice(0,6000),tools,evidence:result.evidence||null}});publicJob.analysis_scope=analysisScope(sessionContext(req));publicJob.scope_generation=generation(req);}if(currentJobScope(req,job)&&job.status==='failed'&&!persistedResult){const current=sessionContext(req),prior=job.payload_json?.previous_analysis_context,attempted=job.payload_json?.analysis_context;if(prior&&prior.requested_subject&&attempted?.requested_subject&&prior.requested_subject!==attempted.requested_subject&&current.requested_subject===attempted.requested_subject)saveSessionContext(req,{...prior,failed_subject_switch:{attempted_subject:attempted.requested_subject,previous_subject:prior.requested_subject,attempted_year:Number(attempted.start_date?.slice(0,4))}});publicJob.error=job.error_code==='WORKER_RESTARTED'?'The worker restarted during analysis; no partial answer was returned. Please retry.':'The analysis could not be completed; no partial answer was returned.';publicJob.code=job.error_code||'ANALYSIS_FAILED';if(job.result_json?.failed_stage)publicJob.failed_stage=job.result_json.failed_stage;}res.json(publicJob);}catch(error){next(error)}});
    router.post('/jobs/:id/cancel',authenticate,protectWrite,json,async(req,res)=>{const job=await owned(req,req.params.id);if(!job)return res.status(404).json({success:false,error:'Analysis job not found'});await analysisJobStore.cancel(job.job_id,ownerKey(parseCookies(req.headers.cookie).oracle_session,sessionSecret));res.json({success:true,job_id:job.job_id,status:['completed','failed'].includes(job.status)?job.status:'cancelled'});});
  }
  router.post('/chat', authenticate, protectWrite, json, async (req, res) => {
    const id=requestId(req.get('x-request-id'));
    const requestStarted=Date.now();
    const messageTemporalContext=resolveKnowledgeDates(req.body?.message,{timestamp:now(),timeZone:'Europe/London'});
    res.setHeader('x-request-id',id);
    const cancellation = new AbortController();
    req.once('aborted',()=>cancellation.abort(new Error('UI request aborted')));
    res.once('close',()=>{ if(!res.writableEnded) cancellation.abort(new Error('UI response closed')); });
    try {
      if (typeof req.body?.message !== 'string' || !req.body.message.trim() || req.body.message.length > 12000) return res.status(400).json({ success: false, error: 'message must be a non-empty string of at most 12000 characters' });
      if((req.body.new_question===true||/^(?:new (?:question|analysis)|forget that|start over)\b/i.test(req.body.message)))clearAnalysis(req,res);
      const requestGeneration=generation(req);
      const previous=sessionContext(req);
      const result=transitionAnalysisContext(previous,req.body.message,{now:now(),reportContext:req.body.report_context||null});
      console.info('Oracle analysis context transition:',{request_id:id,deployed_revision:env.RENDER_GIT_COMMIT||'unavailable',stage:'scope_resolution',requested_subject:result.context.requested_subject,resolved_subject:result.context.requested_subject,selected_route:result.context.tool_route,requested_periods:result.context.included_periods.length||undefined,period_start:result.context.start_date,period_end:result.context.end_date,continuation:result.transition.continuation,changed_fields:result.transition.set,cleared_fields:result.transition.clear,retained_field_names:result.transition.retain,missing_required_field_names:result.transition.missing_required_fields,ready_to_execute:result.transition.ready_to_execute});
      const clarification=(!result.context.campaign_request&&campaignDateClarification(req.body.message,messageTemporalContext))||(result.transition.applies_to_message?clarificationFor(result.context):null);
      const key=sessionKey(req),cached=recentChatEvidence.get(key);
      const recentEvidence=relevantEvidence(cached,result.context);
      const retainedPending=unansweredIntents.get(key);
      const pending=result.context.requested_subject===previous.requested_subject?retainedPending:null;
      const effectiveMessage=pending?`${pending.message}\n\nUser follow-up: ${req.body.message}`:req.body.message;
      const chatStarted=Date.now();
      let answer;
      try {
        answer=clarification?{answer:clarification,tools:[]}:await dispatchAnalysisRequest({message:pending?effectiveMessage:req.body.message,analysisContext:result.transition.applies_to_message?result.context:null,baselineOverview,baselineOptions:{exportOwner:exportOwner(req),requestId:id,deadlineAt:requestStarted+60_000,signal:cancellation.signal,onProviderStage:event=>console.info('Oracle interactive provider stage:',{request_id:id,...event})},chat,chatOptions:{analysisContext:result.transition.applies_to_message?result.context:null,transition:result.transition,recentEvidence,pendingIntent:pending?.message||null,requestId:id,signal:cancellation.signal}});
        console.info('Oracle UI stage outcome:',stageOutcome({id,stage:'agent_request',startedAt:chatStarted,outcome:'success',extra:{tool_count:(answer.tools||[]).length}}));
      } catch(error) {
        if(requestGeneration===generation(req)&&previous.requested_subject!==result.context.requested_subject&&previous.requested_subject&&result.context.requested_subject)saveSessionContext(req,{...previous,failed_subject_switch:{attempted_subject:result.context.requested_subject,previous_subject:previous.requested_subject,attempted_year:Number(result.context.start_date?.slice(0,4))}});
        const failure=transportFailure(error,{stage:error?.failed_stage||'agent_request'});
        console.error('Oracle UI stage outcome:',stageOutcome({id,stage:'agent_request',startedAt:chatStarted,outcome:'failed',error,extra:{failure_kind:failure.failure_kind,failure_stage:failure.failure_stage,status:failure.status,error_code:failure.code}}));
        if(error?.code==='THROTTLED') return res.status(429).json({success:false,code:'SHOPIFY_TEMPORARILY_RATE_LIMITED',error:SHOPIFY_RATE_LIMIT_MESSAGE,request_id:id});
        if(failure.failure_kind==='timeout_or_abort')return res.status(504).json({success:false,code:'ORACLE_AGENT_DEADLINE',error:terminalMessage('agent_request'),request_id:id,failure_stage:failure.failure_stage});
        return res.status(502).json({success:false,code:failure.code,error:'The analysis service rejected the request before it completed. No figures were returned; retry explicitly with the correlation ID.',request_id:id,failure_stage:failure.failure_stage,upstream_status:failure.status});
      }
      if(requestGeneration===generation(req))recentChatEvidence.set(key,{expires_at:now()+15*60*1000,value:{as_of:new Date(now()).toISOString(),answer:String(answer.answer||'').slice(0,6000),tools:(answer.tools||[]).slice(0,20),evidence:answer.evidence||null}});
      // Commit conversational scope only after evidence delivery succeeds. A
      // failed intervening request must not poison the next transition.
      if(requestGeneration===generation(req)&&result.transition.applies_to_message) saveSessionContext(req,contextWithProductEvidence(answer.analysis_context||result.context,answer.evidence));
      // If either the local classifier or the model asks for a date, retain the
      // unanswered request. A short date reply must resume that request rather
      // than replace it with a scope-only answer.
      if(requestGeneration===generation(req)&&/what date range|which date range|what period/i.test(String(answer.answer||''))) unansweredIntents.set(key,{message:pending?.message||req.body.message});
      else if(requestGeneration===generation(req))unansweredIntents.delete(key);
      let proposals = [], proposal_error = null;
      const proposalStarted=Date.now();
      try { proposals = answer.artifact||clarification&&campaignDateClarification(req.body.message,messageTemporalContext)?[]:await proposalsFor(req.body.message, req.oracleUser.sub, messageTemporalContext); console.info('Oracle UI stage outcome:',stageOutcome({id,stage:'knowledge_proposals',startedAt:proposalStarted,outcome:'success',extra:{proposal_count:proposals.length}})); }
      catch (error) { logProposalError(error); console.error('Oracle UI stage outcome:',stageOutcome({id,stage:'knowledge_proposals',startedAt:proposalStarted,outcome:'failed',error})); proposal_error = 'Knowledge proposal could not be generated.'; }
      console.info('Oracle UI stage outcome:',stageOutcome({id,stage:'ui_response',startedAt:requestStarted,outcome:'success'}));
      res.json({ success: true, answer: answer.answer, presentation:answer.presentation||null, evidence:answer.evidence||null, inline_chart:answer.inline_chart||null,charts:answer.charts||answer.evidence?.chart_specs||[], artifact:answer.artifact||null, proposals, proposal_error, scope_generation:generation(req), analysis_scope:analysisScope(sessionContext(req)) });
    } catch (error) {
      if (error?.code === 'THROTTLED') return res.status(429).json({ success: false, code: 'SHOPIFY_TEMPORARILY_RATE_LIMITED', error: SHOPIFY_RATE_LIMIT_MESSAGE });
      console.error('Oracle UI stage outcome:',stageOutcome({id,stage:'ui_response',startedAt:requestStarted,outcome:'failed',error})); res.status(500).json({ success: false, code:'ORACLE_UI_RESPONSE_FAILED',error:'The response could not be prepared. No figures were returned; please retry.',request_id:id });
    }
  });
  router.post('/propose', authenticate, protectWrite, json, async (req, res) => {
    try {
      if (typeof req.body?.message !== 'string' || !req.body.message.trim() || req.body.message.length > 12000) return res.status(400).json({ success: false, error: 'message must be a non-empty string of at most 12000 characters' });
      const temporalContext=resolveKnowledgeDates(req.body.message,{timestamp:now(),timeZone:'Europe/London'}),clarification=campaignDateClarification(req.body.message,temporalContext);
      res.json({ success: true, proposals: clarification?[]:await proposalsFor(req.body.message, req.oracleUser.sub, temporalContext), clarification });
    } catch (error) { logProposalError(error); res.status(503).json({ success: false, error: 'Knowledge proposal could not be generated.' }); }
  });
  const approve = kindScope => async (req, res) => {
    try {
      const kind = req.body?.kind;
      if (kindScope === 'knowledge' && !['fact', 'event', 'definition'].includes(kind)) throw new Error('invalid knowledge kind');
      if (kindScope === 'memory' && kind !== 'memory') throw new Error('invalid memory kind');
      const proposal = validateApprovedProposal(kind, { ...req.body.proposal, created_by: req.oracleUser.sub });
      const result = await writeRecord(bigquery, project, { kind, ...proposal });
      res.status(201).json({ success: true, id: result.id, kind });
    } catch (error) { const message = safeError(error, 'The governed write could not be completed'); console.error('Oracle UI approval failed:', message); res.status(/invalid|must|required|prohibited|hypothesis/i.test(message) ? 400 : 409).json({ success: false, error: message }); }
  };
  router.post('/knowledge/approve', authenticate, protectWrite, json, approve('knowledge'));
  router.post('/memory/approve', authenticate, protectWrite, json, approve('memory'));
  router.get('/knowledge', authenticate, async (req, res) => { try { res.json({ success: true, ...(await knowledgeService.searchKnowledge(queryFilters(req.query, false))) }); } catch (error) { res.status(400).json({ success: false, error: safeError(error) }); } });
  router.get('/knowledge/:id', authenticate, async (req, res) => { try { res.json({ success: true, ...(await knowledgeService.getKnowledgeItem({ knowledge_id: req.params.id })) }); } catch (error) { res.status(400).json({ success: false, error: safeError(error) }); } });
  router.get('/memory', authenticate, async (req, res) => { try { res.json({ success: true, ...(await knowledgeService.searchMemory(queryFilters(req.query, true))) }); } catch (error) { res.status(400).json({ success: false, error: safeError(error) }); } });
  router.get('/memory/:id', authenticate, async (req, res) => { try { res.json({ success: true, ...(await knowledgeService.getMemoryItem({ memory_id: req.params.id })) }); } catch (error) { res.status(400).json({ success: false, error: safeError(error) }); } });
  router.get('/product-mappings', authenticate, async (req,res) => {
    const supplied=String(req.get('x-request-id')||'');
    const requestId=/^[A-Za-z0-9._-]{1,80}$/.test(supplied)?supplied:crypto.randomUUID();
    const started=Date.now();
    let acquired=false;const cancellation=new AbortController();req.once('aborted',()=>cancellation.abort());res.once('close',()=>{if(!res.writableEnded)cancellation.abort()});
    try {
      if(!productMappingService) throw new Error('Product mappings are unavailable');
      await acquireMappingRead(req);acquired=true;
      const payload={success:true,...await productMappingService.list({search:String(req.query.search||''),source:String(req.query.source||''),sort:String(req.query.sort||'impact'),page:req.query.page,pageSize:req.query.page_size,signal:cancellation.signal})};
      // Serialize once (rather than making Express repeat it) and profile local CPU.
      const serializationStarted=performance.now(),serializationCpu=process.cpuUsage(),serialized=JSON.stringify(payload),serializationUsed=process.cpuUsage(serializationCpu);
      console.info('Oracle product mapping read succeeded:',{request_id:requestId,operation:'list_review_candidates',stage:'response_serialization',item_count:payload.items?.length||0,duration_ms:Date.now()-started,serialization_wall_ms:Math.round((performance.now()-serializationStarted)*10)/10,serialization_cpu_ms:Math.round((serializationUsed.user+serializationUsed.system)/100)/10});
      res.setHeader('x-request-id',requestId).type('application/json').send(serialized);
    } catch(error){
      console.error('Oracle product mapping read failed:',mappingReadDiagnostic(error,{request_id:requestId,operation:'list_review_candidates',duration_ms:Date.now()-started}));
      if(!res.headersSent&&!cancellation.signal.aborted)res.setHeader('x-request-id',requestId).status(error.code==='MAPPING_BUSY'?429:503).json({success:false,code:error.code==='MAPPING_BUSY'?'PRODUCT_MAPPING_BUSY':undefined,error:error.code==='MAPPING_BUSY'?error.message:governancePublicError(error),request_id:requestId});
    } finally {if(acquired)releaseMappingRead();}
  });
  router.get('/product-mappings/search', authenticate, async (req,res) => { try { if(!productMappingService) throw new Error('Product mappings are unavailable'); res.json({success:true,...await productMappingService.search({query:String(req.query.q||''),sources:String(req.query.sources||'').split(',').filter(Boolean),exclude_ref:req.query.exclude_ref||null,limit:req.query.limit})}); } catch(error){res.status(400).json({success:false,error:safeError(error)});} });
  router.get('/product-mappings/choice-preview',authenticate,async(req,res)=>{try{if(!productMappingService)throw new Error('Product mappings are unavailable');res.json({success:true,...await productMappingService.previewChoice(String(req.query.candidate_id||''),String(req.query.selected_ref||''),String(req.query.source_ref||''))})}catch(error){console.error('Oracle product choice preview failed:',governanceDiagnostic(error,{operation:'choice_preview',candidate_id:String(req.query.candidate_id||'unknown').slice(0,128),reviewer:req.oracleUser.sub}));res.status(isGovernanceBusinessError(error)?400:503).json({success:false,error:governancePublicError(error)})}});
  router.get('/product-mappings/decisions', authenticate, async (req,res) => { try { if(!productMappingService) throw new Error('Product mappings are unavailable'); res.json({success:true,...await productMappingService.history({status:req.query.status||null,source:req.query.source||null,search:req.query.search||null,reviewer:req.query.reviewer||null,start_date:req.query.start_date||null,end_date:req.query.end_date||null})}); } catch(error){res.status(503).json({success:false,error:safeError(error)});} });
  router.get('/product-mappings/families',authenticate,async(req,res)=>{try{if(!productMappingService)throw new Error('Product mappings are unavailable');res.json({success:true,...await productMappingService.familyHistory()})}catch(error){res.status(503).json({success:false,error:safeError(error)})}});
  const mappingDiagnostic=(req,operation,error)=>governanceDiagnostic(error,{operation,candidate_id:String(req.body?.candidate?.candidate_id||req.body?.decision_id||'unknown').slice(0,128),reviewer:req.oracleUser.sub});
  router.post('/product-mappings/review', authenticate, protectWrite, json, async (req,res) => { const operation=req.body?.status==='approved'?'approve':'reject';console.info('Oracle product mapping governance write received:',{operation,candidate_id:req.body?.candidate?.candidate_id||'unknown',reviewer:req.oracleUser.sub});try { if(!productMappingService) throw new Error('Product mappings are unavailable'); const row=await productMappingService.review(req.body?.candidate,req.body?.status,req.oracleUser.sub,req.body?.note||null);console.info('Oracle product mapping governance write succeeded:',{operation,decision_id:row.decision_id});res.status(201).json({success:true,status:row.status,mapping_method:row.mapping_method}); } catch(error){console.error('Oracle product mapping governance write failed:',mappingDiagnostic(req,operation,error));res.status(isGovernanceBusinessError(error)?409:503).json({success:false,error:governancePublicError(error)});} });
  const mappingWrite=method=>async(req,res)=>{console.info('Oracle product mapping governance write received:',{operation:method,candidate_id:req.body?.candidate?.candidate_id||req.body?.decision_id||'unknown',reviewer:req.oracleUser.sub});try{if(!productMappingService)throw new Error('Product mappings are unavailable');const result=await productMappingService[method](req.body||{},req.oracleUser.sub);console.info('Oracle product mapping governance write succeeded:',{operation:method});res.status(201).json({success:true,...result});}catch(error){console.error('Oracle product mapping governance write failed:',mappingDiagnostic(req,method,error));res.status(isGovernanceBusinessError(error)?409:503).json({success:false,error:governancePublicError(error)});}};
  router.post('/product-mappings/choose-correct',authenticate,protectWrite,json,mappingWrite('chooseCorrect'));
  router.post('/product-mappings/create',authenticate,protectWrite,json,mappingWrite('createMapping'));
  router.post('/product-mappings/change',authenticate,protectWrite,json,mappingWrite('changeMapping'));
  router.post('/product-mappings/revoke',authenticate,protectWrite,json,mappingWrite('revokeMapping'));
  router.post('/product-mappings/reconsider',authenticate,protectWrite,json,mappingWrite('reconsider'));
  router.post('/product-mappings/family/assign',authenticate,protectWrite,json,mappingWrite('assignFamily'));
  router.post('/product-mappings/family/change',authenticate,protectWrite,json,mappingWrite('changeFamily'));
  router.post('/product-mappings/family/revoke',authenticate,protectWrite,json,mappingWrite('revokeFamily'));
  router.post('/product-mappings/bulk-review',authenticate,protectWrite,json,async(req,res)=>{const operationId=String(req.body?.operation_id||'').slice(0,128),started=Date.now();console.info('Oracle product mapping bulk operation started:',{operation_id:operationId,row_count:Array.isArray(req.body?.decisions)?req.body.decisions.length:0});try{if(!productMappingService)throw new Error('Product mappings are unavailable');const result=await productMappingService.bulkReview(req.body||{},req.oracleUser.sub);console.info('Oracle product mapping bulk operation completed:',{operation_id:operationId,row_count:result.results?.length||0,saved:result.succeeded,blocked:result.blocked,failed:result.failed,duration_ms:Date.now()-started});res.status(result.failed||result.blocked?207:201).json({success:result.failed===0&&result.blocked===0,...result})}catch(error){console.error('Oracle product mapping bulk review failed:',{...mappingDiagnostic(req,'bulk_review',error),operation_id:operationId,duration_ms:Date.now()-started});res.status(isGovernanceBusinessError(error)?409:503).json({success:false,error:governancePublicError(error),operation_id:operationId})}});
  router.get('/product-mappings/bulk-review/:operationId',authenticate,async(req,res)=>{try{if(!productMappingService)throw new Error('Product mappings are unavailable');const result=await productMappingService.bulkReviewStatus(req.params.operationId,req.oracleUser.sub);if(!result)return res.status(404).json({success:false,error:'Bulk operation was not found'});res.json({success:true,...result})}catch(error){console.error('Oracle product mapping bulk status failed:',mappingDiagnostic(req,'bulk_review_status',error));res.status(503).json({success:false,error:governancePublicError(error)})}});
  router.get('/collection-classifications',authenticate,async(req,res)=>{try{if(!collectionClassificationService)throw new Error('Collection classifications are unavailable');res.json({success:true,...await collectionClassificationService.list({search:String(req.query.search||''),status:String(req.query.status||''),sort:String(req.query.sort||'product_count_desc')})})}catch(error){res.status(503).json({success:false,error:safeError(error)})}});
  router.get('/collection-classifications/:id',authenticate,async(req,res)=>{try{if(!collectionClassificationService)throw new Error('Collection classifications are unavailable');res.json({success:true,...await collectionClassificationService.detail(req.params.id)})}catch(error){res.status(/not found/i.test(error.message)?404:503).json({success:false,error:safeError(error)})}});
  const collectionWrite=({operation,method,status=200,spread=false})=>async(req,res)=>{const diagnostic={operation,collection_id:String(req.body?.collection_id||req.body?.classification_id||'unknown').slice(0,128),requested_governance_status:String(req.body?.collection_group||req.body?.classification_value||'revoke').slice(0,64),reviewer:req.oracleUser.sub};console.info('Oracle collection governance write received:',diagnostic);try{if(!collectionClassificationService)throw new Error('Collection classifications are unavailable');const result=await collectionClassificationService[method](req.body||{},req.oracleUser.sub);console.info('Oracle collection governance write succeeded:',diagnostic);res.status(status).json(spread?{success:true,...result}:{success:true,decision:result})}catch(error){console.error('Oracle collection governance write failed:',governanceDiagnostic(error,diagnostic));res.status(isGovernanceBusinessError(error)?400:503).json({success:false,error:governancePublicError(error)})}};
  router.post('/collection-classifications/decide',authenticate,protectWrite,json,collectionWrite({operation:'decide',method:'decide',status:201}));
  router.post('/collection-classifications/classify',authenticate,protectWrite,json,collectionWrite({operation:'classify',method:'classify',status:201}));
  router.post('/collection-classifications/revoke',authenticate,protectWrite,json,collectionWrite({operation:'revoke',method:'revoke',spread:true}));
  router.get('/reports/:section', authenticate, async (req, res) => {
    try {
      if (!reportService) throw new Error('Reports are unavailable');
      res.json({ success: true, ...(await reportService(req.params.section, req.query)) });
    } catch (error) { res.status(/date|period|comparison|Unknown/.test(error.message) ? 400 : 503).json({ success: false, error: safeError(error) }); }
  });
  router.get('/reports/export/:format', authenticate, async (req, res) => {
    try {
      if (!reportService) throw new Error('Reports are unavailable');
      const report = await reportService(req.query.section || 'overview', req.query);
      const format = req.params.format;
      if (format === 'csv') { res.type('text/csv').attachment('tgf-ecommerce-report.csv').send(reportCsv(report.rows || [])); return; }
      if (format === 'xlsx') { res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('tgf-ecommerce-report.xlsx').send(Buffer.from(await reportWorkbook(report))); return; }
      if (format === 'pdf') { res.type('application/pdf').attachment('tgf-ecommerce-report.pdf').send(reportPdf(report)); return; }
      res.status(400).json({ success: false, error: 'format must be pdf, xlsx, or csv' });
    } catch (error) { res.status(503).json({ success: false, error: safeError(error) }); }
  });
  router.use((error, req, res, _next) => {
    const tooLarge = error?.type === 'entity.too.large';
    const invalidJson = error instanceof SyntaxError && error?.type === 'entity.parse.failed';
    if (tooLarge) return res.status(413).json({ success: false, code: 'REQUEST_TOO_LARGE', error: 'Request body exceeds the 48 KB limit' });
    if (invalidJson) return res.status(400).json({ success: false, code: 'INVALID_JSON', error: 'Invalid JSON request' });
    const id=req.oracleRequestId||requestId(req.get('x-request-id'));
    console.error('Oracle UI unhandled request failure:',serverFailureDiagnostic({id,path:req.originalUrl,stage:req.oracleFailureStage,error}));
    res.status(500).json({success:false,code:'ORACLE_REQUEST_FAILED',error:'The Oracle request could not be completed. Retry explicitly; if it repeats, give an administrator the correlation ID.',request_id:id});
  });
  return router;
}

function queryFilters(query, memory) {
  const result = { text: query.text || null, start_date: query.start_date || null, end_date: query.end_date || null, status: query.status || null, tags: query.tags ? String(query.tags).split(',').filter(Boolean) : [], limit: Math.min(Number(query.limit) || 20, 50) };
  if (memory) result.memory_type = query.memory_type || null; else result.knowledge_type = query.kind || null;
  return result;
}

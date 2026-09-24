import crypto from 'node:crypto';
import express from 'express';
import { writeRecord } from '../knowledge/admin.js';
import { invalidProposal, needsProposalGeneration, normalizeModelProposal, proposalDiagnostic, validateApprovedProposal } from './proposals.js';
import { createSession, csrfToken, parseCookies, safeError, verifySession } from './ui-security.js';
import { reportCsv, reportPdf, reportWorkbook } from './report-export.js';
import { analysisScope, clarificationFor, emptyAnalysisContext, transitionAnalysisContext } from './analysis-context.js';
import { governanceDiagnostic, governancePublicError, isGovernanceBusinessError } from './governance-diagnostics.js';

const json = express.json({ limit: '48kb', type: 'application/json' });
const allowedOrigins = request => new Set([`${request.protocol}://${request.get('host')}`, process.env.ORACLE_UI_ORIGIN].filter(Boolean));

export function createOracleUiRouter({ knowledgeService, bigquery, project, chat, generateProposals, reportService, productMappingService, collectionClassificationService, env = process.env }) {
  const router = express.Router();
  const password = env.ORACLE_UI_PASSWORD;
  const sessionSecret = env.ORACLE_UI_SESSION_SECRET;
  const proposalModel = env.ORACLE_PROPOSAL_MODEL || 'gpt-5.6';
  const analysisSessions = new Map();
  const logProposalError = error => console.error('Oracle UI proposal generation failed:', proposalDiagnostic(error, proposalModel));
  const mappingReadDiagnostic=(error,context)=>{const value=governanceDiagnostic(error,context);delete value.internal_message;return value};
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
  const proposalsFor = async (message, createdBy) => {
    if (!needsProposalGeneration(message)) return [];
    if (!generateProposals) throw new Error('proposal generator unavailable');
    let existing = [];
    try {
      const [knowledge, memory] = await Promise.all([
        knowledgeService.searchKnowledge({ text: message.slice(0, 1000), knowledge_type: null, start_date: null, end_date: null, status: null, tags: [], limit: 20 }),
        knowledgeService.searchMemory({ text: message.slice(0, 1000), start_date: null, end_date: null, status: null, memory_type: null, tags: [], limit: 10 })
      ]);
      existing = [...(knowledge.items || []), ...(memory.items || [])];
    } catch (error) { console.error('Oracle UI proposal context lookup failed:', safeError(error)); }
    const candidates = await generateProposals({ message, existing, evidence: [] });
    return candidates.slice(0, 12).map(candidate => {
      try { return normalizeModelProposal(candidate, { createdBy, existing }); }
      catch (error) { error.phase = 'proposal_validation'; logProposalError(error); return invalidProposal(candidate); }
    });
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
  router.post('/auth/logout', authenticate, protectWrite, (req, res) => { analysisSessions.delete(sessionKey(req));res.setHeader('Set-Cookie', ['oracle_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0', 'oracle_csrf=; Path=/; SameSite=Strict; Max-Age=0']); res.json({ success: true }); });
  router.get('/session', authenticate, (req, res) => res.json({ success: true, user: req.oracleUser.sub, role: req.oracleUser.role, analysis_scope:analysisScope(sessionContext(req)) }));
  router.post('/analysis/clear',authenticate,protectWrite,json,(req,res)=>{analysisSessions.delete(sessionKey(req));res.json({success:true,analysis_scope:null})});
  router.post('/chat', authenticate, protectWrite, json, async (req, res) => {
    try {
      if (typeof req.body?.message !== 'string' || !req.body.message.trim() || req.body.message.length > 12000) return res.status(400).json({ success: false, error: 'message must be a non-empty string of at most 12000 characters' });
      const previous=sessionContext(req);
      const result=transitionAnalysisContext(previous,req.body.message,{reportContext:req.body.report_context||null});
      if(result.transition.applies_to_message) saveSessionContext(req,result.context);
      console.info('Oracle analysis context transition:',{continuation:result.transition.continuation,changed_fields:result.transition.set,cleared_fields:result.transition.clear,retained_field_names:result.transition.retain,missing_required_field_names:result.transition.missing_required_fields,ready_to_execute:result.transition.ready_to_execute});
      const clarification=result.transition.applies_to_message?clarificationFor(result.context):null;
      const answer=clarification?{answer:clarification,tools:[]}:await chat(req.body.message,{analysisContext:result.transition.applies_to_message?result.context:null,transition:result.transition});
      let proposals = [], proposal_error = null;
      try { proposals = await proposalsFor(req.body.message, req.oracleUser.sub); }
      catch (error) { logProposalError(error); proposal_error = 'Knowledge proposal could not be generated.'; }
      res.json({ success: true, answer: answer.answer, proposals, proposal_error, analysis_scope:analysisScope(sessionContext(req)) });
    } catch (error) { console.error('Oracle UI chat failed:', safeError(error)); res.status(500).json({ success: false, error: safeError(error) }); }
  });
  router.post('/propose', authenticate, protectWrite, json, async (req, res) => {
    try {
      if (typeof req.body?.message !== 'string' || !req.body.message.trim() || req.body.message.length > 12000) return res.status(400).json({ success: false, error: 'message must be a non-empty string of at most 12000 characters' });
      res.json({ success: true, proposals: await proposalsFor(req.body.message, req.oracleUser.sub) });
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
    try {
      if(!productMappingService) throw new Error('Product mappings are unavailable');
      const payload={success:true,...await productMappingService.list({search:String(req.query.search||'')})};
      // Force serialization inside this stage so serialization failures receive the
      // same bounded diagnostic as loading and queue construction failures.
      JSON.stringify(payload);
      console.info('Oracle product mapping read succeeded:',{request_id:requestId,operation:'list_review_candidates',stage:'response_serialization',item_count:payload.items?.length||0,duration_ms:Date.now()-started});
      res.setHeader('x-request-id',requestId).json(payload);
    } catch(error){
      console.error('Oracle product mapping read failed:',mappingReadDiagnostic(error,{request_id:requestId,operation:'list_review_candidates',duration_ms:Date.now()-started}));
      res.setHeader('x-request-id',requestId).status(503).json({success:false,error:governancePublicError(error),request_id:requestId});
    }
  });
  router.get('/product-mappings/search', authenticate, async (req,res) => { try { if(!productMappingService) throw new Error('Product mappings are unavailable'); res.json({success:true,...await productMappingService.search({query:String(req.query.q||''),sources:String(req.query.sources||'').split(',').filter(Boolean),exclude_ref:req.query.exclude_ref||null,limit:req.query.limit})}); } catch(error){res.status(400).json({success:false,error:safeError(error)});} });
  router.get('/product-mappings/choice-preview',authenticate,async(req,res)=>{try{if(!productMappingService)throw new Error('Product mappings are unavailable');res.json({success:true,...await productMappingService.previewChoice(String(req.query.candidate_id||''),String(req.query.selected_ref||''))})}catch(error){console.error('Oracle product choice preview failed:',governanceDiagnostic(error,{operation:'choice_preview',candidate_id:String(req.query.candidate_id||'unknown').slice(0,128),reviewer:req.oracleUser.sub}));res.status(isGovernanceBusinessError(error)?400:503).json({success:false,error:governancePublicError(error)})}});
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
  router.use((error, _req, res, _next) => {
    const tooLarge = error?.type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({ success: false, error: tooLarge ? 'Request body is too large' : 'Invalid JSON request' });
  });
  return router;
}

function queryFilters(query, memory) {
  const result = { text: query.text || null, start_date: query.start_date || null, end_date: query.end_date || null, status: query.status || null, tags: query.tags ? String(query.tags).split(',').filter(Boolean) : [], limit: Math.min(Number(query.limit) || 20, 50) };
  if (memory) result.memory_type = query.memory_type || null; else result.knowledge_type = query.kind || null;
  return result;
}

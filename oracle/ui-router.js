import crypto from 'node:crypto';
import express from 'express';
import { writeRecord } from '../knowledge/admin.js';
import { proposalSearchText, proposeFromMessage, validateApprovedProposal } from './proposals.js';
import { createSession, csrfToken, parseCookies, safeError, verifySession } from './ui-security.js';

const json = express.json({ limit: '48kb', type: 'application/json' });
const allowedOrigins = request => new Set([`${request.protocol}://${request.get('host')}`, process.env.ORACLE_UI_ORIGIN].filter(Boolean));

export function createOracleUiRouter({ knowledgeService, bigquery, project, chat, env = process.env }) {
  const router = express.Router();
  const password = env.ORACLE_UI_PASSWORD;
  const sessionSecret = env.ORACLE_UI_SESSION_SECRET;
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
  const proposalFor = async (message, createdBy) => {
    const candidate = proposeFromMessage(message, { createdBy });
    if (!candidate || candidate.kind === 'memory') return candidate;
    try {
      const result = await knowledgeService.searchKnowledge({ text: proposalSearchText(candidate), knowledge_type: candidate.kind, start_date: null, end_date: null, status: null, tags: [], limit: 10 });
      return proposeFromMessage(message, { createdBy, existing: result.items || [] });
    } catch (error) {
      console.error('Oracle UI duplicate check failed:', safeError(error));
      return candidate;
    }
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
  router.post('/auth/logout', authenticate, protectWrite, (_req, res) => { res.setHeader('Set-Cookie', ['oracle_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0', 'oracle_csrf=; Path=/; SameSite=Strict; Max-Age=0']); res.json({ success: true }); });
  router.get('/session', authenticate, (req, res) => res.json({ success: true, user: req.oracleUser.sub, role: req.oracleUser.role }));
  router.post('/chat', authenticate, protectWrite, json, async (req, res) => {
    try {
      if (typeof req.body?.message !== 'string' || !req.body.message.trim() || req.body.message.length > 12000) return res.status(400).json({ success: false, error: 'message must be a non-empty string of at most 12000 characters' });
      const answer = await chat(req.body.message);
      const proposal = await proposalFor(req.body.message, req.oracleUser.sub);
      res.json({ success: true, answer: answer.answer, proposal });
    } catch (error) { console.error('Oracle UI chat failed:', safeError(error)); res.status(500).json({ success: false, error: safeError(error) }); }
  });
  router.post('/propose', authenticate, protectWrite, json, async (req, res) => {
    try { res.json({ success: true, proposal: await proposalFor(req.body?.message, req.oracleUser.sub) }); }
    catch (error) { res.status(400).json({ success: false, error: safeError(error, 'The proposal is invalid') }); }
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

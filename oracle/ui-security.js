import crypto from 'node:crypto';

const TOKEN_LIFETIME_SECONDS = 8 * 60 * 60;

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function signature(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

export function createSession(identity, secret, now = Date.now()) {
  const payload = base64url(JSON.stringify({ sub: identity, role: 'admin', exp: Math.floor(now / 1000) + TOKEN_LIFETIME_SECONDS, jti: crypto.randomUUID() }));
  return `${payload}.${signature(payload, secret)}`;
}

export function verifySession(token, secret, now = Date.now()) {
  if (!token || !secret) return null;
  const [payload, supplied, extra] = token.split('.');
  if (!payload || !supplied || extra) return null;
  const expected = signature(payload, secret);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url'));
    return decoded.role === 'admin' && decoded.exp > Math.floor(now / 1000) ? decoded : null;
  } catch { return null; }
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

export function redactError(value) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value?.message || 'Internal error'); }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(authorization|access_token|refresh_token|private_key|client_secret)(["'\s:=]+)([^,}\]\s]+)/gi, '$1$2[REDACTED]')
    .replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
}

export function safeError(error, fallback = 'The request could not be completed') {
  const message = redactError(error?.message || '');
  const safeValidation = /^(invalid |missing |prohibited |[a-z_]+ must |dated events|unknown date|memory evidence|a hypothesis|supersedes target|record is already)/i.test(message);
  return safeValidation ? message.slice(0, 500) : fallback;
}

export function csrfToken() { return crypto.randomBytes(24).toString('base64url'); }

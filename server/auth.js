// server/auth.js
// Auth compartida por token, en tiempo constante.

import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * @param {string|undefined|null} tokenProvided
 * @returns {boolean}
 */
export function isAuthorized(tokenProvided) {
  const expected = config.AGY_TOKEN;
  if (!expected) return true; // sin token configurado = sin auth
  const provided = tokenProvided || '';
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Middleware express: exige auth en toda /api salvo GET /api/health.
 */
export function restAuth(req, res, next) {
  if (req.method === 'GET' && req.path === '/health') {
    next();
    return;
  }
  let token = null;
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) {
    token = header.slice('Bearer '.length);
  } else if (req.query && typeof req.query.token === 'string') {
    token = req.query.token;
  }
  if (!isAuthorized(token)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

/**
 * Comprueba auth para una conexión WS a partir de la URL (con ?token=) o de headers.
 * @param {URL} url
 * @param {import('node:http').IncomingMessage} [req]
 * @returns {boolean}
 */
export function wsAuth(url, req = null) {
  let token = url ? url.searchParams.get('token') : null;
  if (!token && req && req.headers) {
    const header = req.headers['authorization'];
    if (header && header.startsWith('Bearer ')) {
      token = header.slice('Bearer '.length);
    }
  }
  return isAuthorized(token);
}


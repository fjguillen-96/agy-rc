// public/js/api.js
// Wrapper fetch con token Bearer (localStorage) y helper de URL para el WS.

const TOKEN_KEY = 'agyrc.token';

export class UnauthorizedError extends Error {
  constructor(message = 'unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // localStorage no disponible; ignorar
  }
}

/**
 * @param {string} path ruta relativa a /api, p.ej. '/sessions'
 * @param {RequestInit} [opts]
 * @returns {Promise<any>} JSON parseado, o texto si Content-Type no es JSON, o null si 204.
 */
export async function api(path, opts = {}) {
  const token = getToken();
  const headers = new Headers(opts.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (opts.body && !headers.has('Content-Type') && typeof opts.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }

  const url = path.startsWith('/api') ? path : `/api${path}`;
  const res = await fetch(url, { ...opts, headers });

  if (res.status === 401) {
    throw new UnauthorizedError();
  }

  if (res.status === 204) {
    return null;
  }

  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    const message = (isJson && body && body.error) || `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body;
}

/**
 * Construye la URL del WebSocket de attach.
 * @param {string} sessionId
 * @param {number} cols
 * @param {number} rows
 * @returns {string}
 */
export function wsUrl(sessionId, cols, rows) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({
    session: sessionId,
    cols: String(cols),
    rows: String(rows),
  });
  const token = getToken();
  if (token) params.set('token', token);
  return `${proto}//${location.host}/ws?${params.toString()}`;
}

/**
 * Construye la URL del WebSocket de chat (§2.3 CHAT.md).
 * @param {string} chatId
 * @returns {string}
 */
export function chatWsUrl(chatId) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ chat: chatId });
  const token = getToken();
  if (token) params.set('token', token);
  return `${proto}//${location.host}/ws/chat?${params.toString()}`;
}

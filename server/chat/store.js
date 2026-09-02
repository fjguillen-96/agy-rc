// server/chat/store.js
// Store de chats: metadatos en data/chats/<id>.json (uno por chat) + mensajes
// en data/chats/<id>.ndjson (una línea por upsert; el último gana por `id`).
// Escritura de meta atómica (tmp+rename), igual que sessions.js.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../sessions.js';

const COMPACT_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_LOG_LINES = 4000;
const TRIM_LOG_LINES = 2000;

function chatsDir() {
  return path.join(config.AGY_DATA_DIR, 'chats');
}

function metaPath(id) {
  return path.join(chatsDir(), `${id}.json`);
}

function messagesPath(id) {
  return path.join(chatsDir(), `${id}.ndjson`);
}

function logPath(id) {
  return path.join(chatsDir(), `${id}.log`);
}

/**
 * Rutas del proceso agy del chat cuando corre en tmux (ver tmux-proc.js): FIFO de stdin y
 * ficheros append de stdout/stderr, junto a los demás ficheros del chat.
 * @param {string} id
 * @returns {{fifo:string, out:string, err:string}}
 */
export function procPaths(id) {
  return {
    fifo: path.join(chatsDir(), `${id}.in`),
    out: path.join(chatsDir(), `${id}.out`),
    err: path.join(chatsDir(), `${id}.err`),
  };
}

/**
 * Carpeta de adjuntos subidos desde la app para un chat (`data/uploads/<id>/`). agy la recibe
 * como workspace extra (`--add-dir`) para poder leer los archivos con view_file.
 * @param {string} id chat id
 * @returns {string} ruta absoluta
 */
export function uploadsDir(id) {
  return path.join(config.AGY_DATA_DIR, 'uploads', id);
}

/**
 * Genera un id de chat: `c_` + 10 hex aleatorios.
 * @returns {string}
 */
export function newChatId() {
  return `c_${crypto.randomBytes(5).toString('hex')}`;
}

async function ensureDir() {
  await fs.mkdir(chatsDir(), { recursive: true });
}

/**
 * Escritura atómica de un fichero (tmp + rename), como sessions.js.
 * @param {string} file
 * @param {string} content
 */
async function writeFileAtomic(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmpFile = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tmpFile, content, 'utf8');
  await fs.rename(tmpFile, file);
}

/**
 * Crea el meta de un chat nuevo y lo persiste.
 * @param {object} fields
 * @returns {Promise<object>} Chat
 */
export async function createChat(fields) {
  await ensureDir();
  const id = newChatId();
  const now = new Date().toISOString();
  const chat = {
    id,
    title: fields.title || '',
    cwd: fields.cwd,
    model: fields.model ?? null,
    effort: fields.effort ?? null,
    mode: fields.mode || 'normal',
    autoApprove: fields.autoApprove !== false,
    newProject: Boolean(fields.newProject),
    conversationId: fields.conversationId || null,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
    state: 'idle',
  };
  await saveChat(chat);
  return chat;
}

/**
 * Persiste (sobrescribe) el meta de un chat. Escritura atómica.
 * @param {object} chat
 */
export async function saveChat(chat) {
  await ensureDir();
  await writeFileAtomic(metaPath(chat.id), JSON.stringify(chat, null, 2));
}

/**
 * Lee el meta de un chat. Lanza HttpError 404 si no existe.
 * @param {string} id
 * @returns {Promise<object>} Chat
 */
export async function getChat(id) {
  try {
    const raw = await fs.readFile(metaPath(id), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new HttpError(404, 'chat no encontrado');
    throw err;
  }
}

/**
 * Comprueba si existe un chat sin lanzar.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function chatExists(id) {
  try {
    await fs.access(metaPath(id));
    return true;
  } catch {
    return false;
  }
}

/**
 * Lista todos los chats (metas), ordenados por updatedAt desc.
 * @returns {Promise<object[]>}
 */
export async function listChats() {
  await ensureDir();
  const entries = await fs.readdir(chatsDir(), { withFileTypes: true });
  const ids = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.startsWith('.'))
    .map((e) => e.name.slice(0, -('.json'.length)));

  const chats = [];
  for (const id of ids) {
    try {
      chats.push(await getChat(id));
    } catch {
      // meta corrupto/ilegible: se ignora
    }
  }
  chats.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return chats;
}

/**
 * Borra un chat (meta + mensajes).
 * @param {string} id
 */
export async function deleteChat(id) {
  await Promise.all([
    fs.rm(metaPath(id), { force: true }),
    fs.rm(messagesPath(id), { force: true }),
    fs.rm(logPath(id), { force: true }),
    fs.rm(uploadsDir(id), { recursive: true, force: true }),
    ...Object.values(procPaths(id)).map((p) => fs.rm(p, { force: true })),
  ]);
}

/**
 * Añade una línea de upsert al ndjson de mensajes. Compacta si supera el umbral.
 * @param {string} id chat id
 * @param {object} message
 */
export async function appendMessage(id, message) {
  await ensureDir();
  const file = messagesPath(id);
  await fs.appendFile(file, JSON.stringify(message) + '\n', 'utf8');
  await maybeCompact(id);
}

/**
 * Reconstruye el estado final de los mensajes por `id`, conservando el orden
 * de primera aparición. Si se pasa `limit`, devuelve los últimos `limit`.
 * @param {string} id chat id
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
export async function readMessages(id, limit) {
  let raw;
  try {
    raw = await fs.readFile(messagesPath(id), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const order = [];
  const byId = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue; // línea corrupta: se ignora
    }
    if (!msg || typeof msg.id !== 'string') continue;
    if (!byId.has(msg.id)) order.push(msg.id);
    byId.set(msg.id, msg);
  }
  const all = order.map((mid) => byId.get(mid));
  if (typeof limit === 'number' && limit > 0 && all.length > limit) {
    return all.slice(all.length - limit);
  }
  return all;
}

/**
 * Compacta el ndjson (reescribe solo el último estado de cada id) si el
 * fichero supera COMPACT_THRESHOLD_BYTES.
 * @param {string} id
 */
async function maybeCompact(id) {
  const file = messagesPath(id);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return;
  }
  if (stat.size <= COMPACT_THRESHOLD_BYTES) return;
  const messages = await readMessages(id);
  const content = messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : '');
  await writeFileAtomic(file, content);
}

/**
 * Título por defecto: primeros 60 caracteres del primer mensaje del usuario.
 * @param {string} text
 * @returns {string}
 */
export function defaultTitle(text) {
  const trimmed = String(text || '').trim();
  return trimmed.slice(0, 60);
}

// -- registro crudo del CLI (data/chats/<id>.log, NDJSON: {ts, src, line}) -------

/**
 * Añade una entrada al registro crudo del CLI de un chat. Recorta el fichero si hace falta.
 * @param {string} id chat id
 * @param {{ts:number, src:'cmd'|'out'|'err'|'sys', line:string}} entry
 */
export async function appendLog(id, entry) {
  await ensureDir();
  await fs.appendFile(logPath(id), JSON.stringify(entry) + '\n', 'utf8');
  await trimLogIfNeeded(id);
}

/**
 * Lee las últimas `limit` entradas del registro crudo de un chat. Tolerante a fichero ausente
 * o líneas corruptas (se ignoran).
 * @param {string} id chat id
 * @param {number} [limit=500]
 * @returns {Promise<Array<{ts:number, src:string, line:string}>>}
 */
export async function readLogTail(id, limit = 500) {
  let raw;
  try {
    raw = await fs.readFile(logPath(id), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // línea corrupta: se ignora
    }
  }
  const n = typeof limit === 'number' && limit > 0 ? limit : 500;
  return entries.length > n ? entries.slice(entries.length - n) : entries;
}

/**
 * Recorta el registro crudo de un chat a las últimas `TRIM_LOG_LINES` líneas cuando supera
 * `MAX_LOG_LINES`. Escritura atómica, igual que `maybeCompact` para el ndjson de mensajes.
 * @param {string} id chat id
 */
export async function trimLogIfNeeded(id) {
  const file = logPath(id);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  if (lines.length <= MAX_LOG_LINES) return;
  const tail = lines.slice(lines.length - TRIM_LOG_LINES);
  await writeFileAtomic(file, tail.join('\n') + '\n');
}

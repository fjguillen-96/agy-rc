// server/chat/transcript.js
// Lectura del almacenamiento propio de agy: history.jsonl (prompts recientes)
// y brain/<conversation_id>/.system_generated/logs/transcript.jsonl (histórico
// completo de una conversación), para "reanudar conversación anterior".
// Todo tolerante a ficheros/carpetas ausentes o corruptos.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { summarizeTool } from './runner.js';

const MAX_TOOL_OUTPUT_BYTES = 20 * 1024;

/**
 * Carpeta base del almacenamiento de agy. Se lee de `process.env.AGY_CLI_HOME` EN CADA LLAMADA
 * (no se cachea al importar el módulo), para que los tests puedan aislarla con un tmpdir.
 * @returns {string}
 */
export function baseDir() {
  return process.env.AGY_CLI_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

function toIso(ts) {
  if (ts === undefined || ts === null || ts === '') return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Extrae el contenido de `<USER_REQUEST>…</USER_REQUEST>`, descartando
 * `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>` y cualquier otro texto
 * fuera del envoltorio. Tolerante: si no hay envoltorio, devuelve el texto tal cual.
 * @param {string} content
 * @returns {string}
 */
export function extractUserRequest(content) {
  const text = String(content ?? '');
  const m = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  return (m ? m[1] : text).trim();
}

async function readHistoryConversations(base) {
  let raw;
  try {
    raw = await fs.readFile(path.join(base, 'history.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const byId = new Map();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const conversationId = entry && entry.conversationId;
    if (!conversationId || typeof conversationId !== 'string') continue;

    let cur = byId.get(conversationId);
    if (!cur) {
      cur = { conversationId, title: '', workspace: '', lastAt: null, source: 'history' };
      byId.set(conversationId, cur);
    }
    const display = typeof entry.display === 'string' ? entry.display.trim() : '';
    if (display && display !== 'exit') cur.title = display;
    if (typeof entry.workspace === 'string' && entry.workspace) cur.workspace = entry.workspace;
    const iso = toIso(entry.timestamp);
    if (iso && (!cur.lastAt || iso > cur.lastAt)) cur.lastAt = iso;
  }
  return [...byId.values()];
}

async function readBrainConversations(base) {
  const brainDir = path.join(base, 'brain');
  let entries;
  try {
    entries = await fs.readdir(brainDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const conversationId = d.name;
    const transcriptFile = path.join(brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
    let stat;
    try {
      stat = await fs.stat(transcriptFile);
    } catch {
      continue; // sin transcript: no cuenta como conversación reanudable
    }

    let title = '';
    try {
      const raw = await fs.readFile(transcriptFile, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let step;
        try {
          step = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (step && step.type === 'USER_INPUT') {
          const text = extractUserRequest(step.content);
          if (text) {
            title = text.slice(0, 200);
            break;
          }
        }
      }
    } catch {
      // ilegible: título vacío, se mantiene tolerante
    }

    out.push({
      conversationId,
      title,
      workspace: '',
      lastAt: stat.mtime.toISOString(),
      source: 'brain',
    });
  }
  return out;
}

/**
 * Lista conversaciones anteriores de agy (history.jsonl ∪ carpetas de brain
 * con transcript), ordenadas por fecha desc. Dedupe por conversationId
 * (una entrada de history.jsonl prevalece sobre la de brain).
 * @param {number} [limit=50]
 * @returns {Promise<Array<{conversationId:string, title:string, workspace:string, lastAt:string|null, source:'history'|'brain'}>>}
 */
export async function listConversations(limit = 50) {
  const base = baseDir();
  const [historyEntries, brainEntries] = await Promise.all([
    readHistoryConversations(base),
    readBrainConversations(base),
  ]);

  const byId = new Map();
  for (const e of historyEntries) byId.set(e.conversationId, e);
  for (const e of brainEntries) {
    if (!byId.has(e.conversationId)) byId.set(e.conversationId, e);
  }

  const all = [...byId.values()];
  all.sort((a, b) => {
    const av = a.lastAt || '';
    const bv = b.lastAt || '';
    return av < bv ? 1 : av > bv ? -1 : 0;
  });

  const n = Number.isFinite(limit) && limit > 0 ? limit : 50;
  return all.slice(0, n);
}

/**
 * Lee el `thinking` (texto plano del razonamiento) de un paso PLANNER_RESPONSE concreto del
 * transcript.jsonl de una conversación. Tolerante: fichero ausente, línea corrupta, step
 * inexistente o sin `thinking` → `null`.
 * @param {string} conversationId
 * @param {number} stepIndex
 * @returns {Promise<string|null>}
 */
export async function readStepThinking(conversationId, stepIndex) {
  const transcriptFile = path.join(
    baseDir(),
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
  let raw;
  try {
    raw = await fs.readFile(transcriptFile, 'utf8');
  } catch {
    return null;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let step;
    try {
      step = JSON.parse(trimmed);
    } catch {
      continue; // línea corrupta: se ignora
    }
    if (!step || typeof step !== 'object') continue;
    if (step.step_index === stepIndex && step.type === 'PLANNER_RESPONSE') {
      const thinking = typeof step.thinking === 'string' ? step.thinking.trim() : '';
      return thinking || null;
    }
  }
  return null;
}

/**
 * Importa el transcript completo de una conversación de agy a la lista de
 * mensajes del chat (formato `Msg[]`, ver CHAT.md §2.1). Tolerante a fichero
 * ausente o corrupto (línea a línea).
 * @param {string} conversationId
 * @returns {Promise<Array<object>>}
 */
export async function importTranscript(conversationId) {
  const transcriptFile = path.join(
    baseDir(),
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );
  let raw;
  try {
    raw = await fs.readFile(transcriptFile, 'utf8');
  } catch {
    return [];
  }

  const messages = [];
  const openToolQueue = []; // tool messages sin output aún, en orden de aparición
  let seq = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let step;
    try {
      step = JSON.parse(trimmed);
    } catch {
      continue; // línea corrupta: se ignora
    }
    if (!step || typeof step !== 'object') continue;

    const stepIndex = step.step_index !== undefined ? step.step_index : seq;
    const ts = toIso(step.created_at) || new Date(Date.now() + seq).toISOString();
    seq += 1;

    if (step.type === 'USER_INPUT') {
      const text = extractUserRequest(step.content);
      if (text) {
        messages.push({ id: `u-${conversationId}-${stepIndex}`, ts, role: 'user', text });
      }
    } else if (step.type === 'PLANNER_RESPONSE') {
      const text = typeof step.content === 'string' ? step.content : '';
      const thinking = typeof step.thinking === 'string' ? step.thinking.trim() : '';
      if (text.trim()) {
        const msg = { id: `a-${conversationId}-${stepIndex}`, ts, role: 'assistant', text, done: true };
        if (thinking) msg.thinking = thinking;
        messages.push(msg);
      } else if (thinking) {
        messages.push({ id: `a-${conversationId}-${stepIndex}`, ts, role: 'assistant', text: '', done: true, thinking });
      }
      const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      toolCalls.forEach((tc, i) => {
        const name = tc && typeof tc.name === 'string' ? tc.name : 'tool';
        const params = tc && tc.args && typeof tc.args === 'object' ? tc.args : {};
        const msg = {
          id: `t-${conversationId}-${stepIndex}-${i}`,
          ts,
          role: 'tool',
          name,
          params,
          summary: summarizeTool(name, params),
          state: 'done',
        };
        messages.push(msg);
        openToolQueue.push(msg);
      });
    } else if (step.type === 'GENERIC') {
      const output = typeof step.content === 'string' ? step.content : '';
      const target = openToolQueue.pop();
      if (target && output) {
        target.output = output.slice(0, MAX_TOOL_OUTPUT_BYTES);
      }
      // sin tool pendiente: se ignora (según contrato)
    }
    // otros `type` desconocidos: se ignoran (tolerante)
  }

  return messages;
}

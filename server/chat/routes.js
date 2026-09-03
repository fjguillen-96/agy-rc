// server/chat/routes.js
// Router REST del modo chat, según §2.2 de docs/CHAT.md. Se monta en `/api`
// (server/index.js) junto al router de sesiones/terminal.

import { isCliCommand, runCliCommand, CHAT_COMMANDS, resolveModelId, listModels } from '../agy.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { restAuth } from '../auth.js';
import { isUploadRequest } from '../routes.js';
import { validateCwd, HttpError } from '../sessions.js';
import * as store from './store.js';
import * as transcript from './transcript.js';
import { systemMessage, mimeFromName } from './runner.js';

const CHAT_ID_RE = /^c_[0-9a-f]{10}$/;
const MODEL_RE = /^[\w.-]{1,64}$/;
const EFFORT_VALUES = new Set(['low', 'medium', 'high']);
const MODE_VALUES = new Set(['normal', 'plan', 'accept-edits']);
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function wrap(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function validateModel(model) {
  if (model === undefined || model === null || model === '') return null;
  if (typeof model !== 'string' || !MODEL_RE.test(model)) {
    throw new HttpError(400, 'model inválido');
  }
  return model;
}

function validateEffort(effort) {
  if (effort === undefined || effort === null || effort === '') return null;
  if (typeof effort !== 'string' || !EFFORT_VALUES.has(effort)) {
    throw new HttpError(400, 'effort debe ser low|medium|high');
  }
  return effort;
}

function validateMode(mode) {
  if (mode === undefined || mode === null || mode === '') return 'normal';
  if (typeof mode !== 'string' || !MODE_VALUES.has(mode)) {
    throw new HttpError(400, 'mode debe ser normal|plan|accept-edits');
  }
  return mode;
}

function validateConversationId(conversationId) {
  if (conversationId === undefined || conversationId === null || conversationId === '') return null;
  if (typeof conversationId !== 'string' || !UUID_V4_RE.test(conversationId)) {
    throw new HttpError(400, 'conversationId debe ser un uuid v4');
  }
  return conversationId;
}

function validateText(text, { allowEmpty = false } = {}) {
  if (allowEmpty && (text === undefined || text === null || text === '')) return '';
  if (typeof text !== 'string' || text.length < 1 || text.length > 100000) {
    throw new HttpError(400, 'text debe ser una cadena de 1 a 100000 caracteres');
  }
  return text;
}

const UPLOAD_MAX_BYTES = 30 * 1024 * 1024;
const UPLOAD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$/;
// Extensiones que el navegador renderizaría con scripts: se sirven como descarga, nunca inline.
const ACTIVE_CONTENT_EXT = new Set(['.html', '.htm', '.xhtml', '.svg', '.svgz', '.xml', '.xsl', '.js', '.mjs']);

/**
 * Nombre de archivo seguro para guardar en la carpeta de adjuntos: sin rutas ni caracteres raros,
 * conservando la extensión si se puede. Si no queda nada útil → `archivo[.ext]`.
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeUploadName(raw) {
  const base = typeof raw === 'string' ? path.basename(raw.replace(/\\/g, '/')) : '';
  const rawExt = path.extname(base).toLowerCase();
  const ext = /^\.[a-z0-9]{1,11}$/.test(rawExt) ? rawExt : '';
  let stem = base.slice(0, base.length - path.extname(base).length);
  stem = stem.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^[^A-Za-z0-9]+/, '').trim().slice(0, 100);
  if (!stem) stem = 'archivo';
  const name = `${stem}${ext}`;
  return UPLOAD_NAME_RE.test(name) ? name : 'archivo';
}

/**
 * Evita sobrescribir: `foto.jpg` → `foto-1.jpg`, `foto-2.jpg`…
 * @param {string} dir
 * @param {string} name
 * @returns {Promise<string>}
 */
async function uniqueUploadName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 1; i < 1000; i++) {
    try {
      await fs.access(path.join(dir, candidate));
    } catch {
      return candidate;
    }
    candidate = `${stem}-${i}${ext}`;
  }
  throw new HttpError(409, 'demasiados archivos con el mismo nombre');
}

/**
 * Texto representativo de un mensaje para previsualización (`lastMessage`).
 * @param {object} msg
 * @returns {string}
 */
function previewText(msg) {
  if (msg.role === 'tool') return msg.summary || msg.name || '';
  return msg.text || '';
}

function toChatSummary(chat, lastMessage) {
  const out = { ...chat };
  if (lastMessage) {
    out.lastMessage = { role: lastMessage.role, text: previewText(lastMessage).slice(0, 140) };
  }
  return out;
}

/**
 * @param {import('./runner.js').ChatManager} manager
 * @param {{execImpl?: Function}} [deps] `execImpl` sustituye a execFile para POST /chats/:id/command (tests)
 * @returns {import('express').Router}
 */
export function createChatRouter(manager, deps = {}) {
  const router = express.Router();
  // En PUT /uploads el cuerpo es el archivo crudo: express.json no debe tocarlo (un .json subido
  // no se parsea ni se limita a 256 kb).
  const jsonBody = express.json({ limit: '256kb' });
  router.use(restAuth);
  router.use((req, res, next) => {
    if (isUploadRequest(req)) return next();
    jsonBody(req, res, (err) => {
      if (err) {
        // body-parser distingue 413 (demasiado grande) / 415 de un JSON malformado (400).
        const status = err.status === 413 || err.status === 415 ? err.status : 400;
        return next(new HttpError(status, status === 400 ? 'invalid JSON payload' : err.message));
      }
      next();
    });
  });

  router.param('id', (req, res, next, id) => {
    if (typeof id !== 'string' || !CHAT_ID_RE.test(id)) {
      next(new HttpError(400, 'id de chat inválido'));
      return;
    }
    next();
  });

  // -- GET /chats ---------------------------------------------------------

  router.get(
    '/chats',
    wrap(async (req, res) => {
      const chats = await store.listChats();
      const out = await Promise.all(
        chats.map(async (chat) => {
          const messages = await store.readMessages(chat.id, 1);
          return toChatSummary(chat, messages[messages.length - 1]);
        })
      );
      res.json(out);
    })
  );

  // -- POST /chats ----------------------------------------------------------

  router.post(
    '/chats',
    wrap(async (req, res) => {
      const body = req.body || {};
      if (typeof body.cwd !== 'string' || !body.cwd) {
        throw new HttpError(400, 'cwd es obligatorio');
      }
      const resolvedCwd = await validateCwd(body.cwd);
      const model = validateModel(body.model);
      const effort = validateEffort(body.effort);
      const mode = validateMode(body.mode);
      const conversationId = validateConversationId(body.conversationId);
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';

      const chat = await store.createChat({
        title,
        cwd: resolvedCwd,
        model,
        effort,
        mode,
        autoApprove: body.autoApprove !== false,
        newProject: Boolean(body.newProject),
        conversationId,
      });

      if (conversationId) {
        const messages = await transcript.importTranscript(conversationId);
        for (const msg of messages) {
          await store.appendMessage(chat.id, msg);
        }
        if (!chat.title) {
          const firstUser = messages.find((m) => m.role === 'user');
          if (firstUser) {
            chat.title = store.defaultTitle(firstUser.text);
            await store.saveChat(chat);
          }
        }
      }

      res.status(201).json(chat);
    })
  );

  // -- GET /chats/:id -------------------------------------------------------

  router.get(
    '/chats/:id',
    wrap(async (req, res) => {
      const chat = await store.getChat(req.params.id);
      const limit = Number.parseInt(req.query.limit, 10) || 200;
      const messages = await store.readMessages(req.params.id, limit);
      res.json({ chat, messages });
    })
  );

  // -- PATCH /chats/:id -----------------------------------------------------

  router.patch(
    '/chats/:id',
    wrap(async (req, res) => {
      const chat = await store.getChat(req.params.id);
      const body = req.body || {};
      const patch = {};

      if (body.title !== undefined) {
        if (typeof body.title !== 'string' || body.title.length > 200) {
          throw new HttpError(400, 'title inválido');
        }
        patch.title = body.title.trim();
      }
      let flagsChanged = false;
      if (body.effort !== undefined) {
        patch.effort = validateEffort(body.effort);
        if (patch.effort !== chat.effort) flagsChanged = true;
        if (!body.model && chat.model) {
          try {
            const resolved = await resolveModelId(chat.model, patch.effort);
            if (resolved && resolved !== chat.model) {
              patch.model = resolved;
              flagsChanged = true;
            }
          } catch {}
        }
      }
      if (body.model !== undefined) {
        patch.model = validateModel(body.model);
        if (patch.model !== chat.model) flagsChanged = true;
        if (patch.model && body.effort === undefined) {
          try {
            const models = await listModels();
            const current = models.find((m) => m.id === patch.model);
            if (current && current.effort && current.effort !== chat.effort) {
              patch.effort = current.effort;
              flagsChanged = true;
            }
          } catch {}
        }
      }
      if (body.mode !== undefined) {
        patch.mode = validateMode(body.mode);
        if (patch.mode !== chat.mode) flagsChanged = true;
      }
      if (body.autoApprove !== undefined) {
        patch.autoApprove = Boolean(body.autoApprove);
        if (patch.autoApprove !== chat.autoApprove) flagsChanged = true;
      }

      Object.assign(chat, patch, { updatedAt: new Date().toISOString() });
      await store.saveChat(chat);

      const runner = manager.peekRunner(chat.id);
      if (runner) {
        Object.assign(runner.chat, patch);
        if (flagsChanged && runner.isAlive()) {
          await runner.restart();
        }
      }

      res.json(chat);
    })
  );

  // -- DELETE /chats/:id ------------------------------------------------------

  router.delete(
    '/chats/:id',
    wrap(async (req, res) => {
      await store.getChat(req.params.id); // 404 si no existe
      await manager.removeRunner(req.params.id);
      await store.deleteChat(req.params.id);
      res.status(204).end();
    })
  );

  // -- POST /chats/:id/send ---------------------------------------------------

  router.post(
    '/chats/:id/send',
    wrap(async (req, res) => {
      const body = req.body || {};
      const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
      const text = validateText(body.text, { allowEmpty: hasAttachments });
      const runner = await manager.getRunner(req.params.id);
      const message = await runner.send(text, hasAttachments ? body.attachments : []);
      res.status(202).json({ messageId: message.id });
    })
  );

  // -- POST /chats/:id/command {cmd} -----------------------------------------
  // Comandos "/" que agy responde por sí mismo (/usage, /credits, /skills…): en stream-json los
  // rechaza por stdin, así que se ejecutan como `agy --print=/cmd` aparte y su salida entra en el
  // chat como mensaje de sistema kind 'cli' (no consume turno ni toca la conversación de agy).

  router.post(
    '/chats/:id/command',
    wrap(async (req, res) => {
      const cmd = typeof (req.body || {}).cmd === 'string' ? req.body.cmd.trim() : '';
      if (!isCliCommand(cmd)) {
        const allowed = CHAT_COMMANDS.filter((c) => c.kind === 'cli').map((c) => c.cmd).join(', ');
        throw new HttpError(400, `cmd debe ser uno de: ${allowed}`);
      }
      const runner = await manager.getRunner(req.params.id);
      const cwd = await validateCwd(runner.chat.cwd);
      let message;
      try {
        const text = await runCliCommand(cmd, cwd, deps.execImpl ? { execImpl: deps.execImpl } : undefined);
        message = { ...systemMessage('cli', text), cmd };
      } catch (err) {
        const reason = err && err.message ? err.message : '';
        message = systemMessage('error', `${cmd}: ${reason || 'falló'}`, undefined, { key: 'sys.cliFailed', params: { cmd, message: reason } });
      }
      await runner.upsert(message);
      res.json({ messageId: message.id, kind: message.kind });
    })
  );

  // -- PUT /chats/:id/uploads?name=  · GET /chats/:id/uploads/:name ----------
  // Adjuntos del compositor: se guardan en data/uploads/<chat>/ (workspace extra de agy) y el
  // mensaje lleva sus rutas absolutas (ver runner.composePrompt). Cuerpo = bytes del archivo.

  router.put(
    '/chats/:id/uploads',
    express.raw({ type: '*/*', limit: UPLOAD_MAX_BYTES }),
    wrap(async (req, res) => {
      if (!(await store.chatExists(req.params.id))) throw new HttpError(404, 'chat no encontrado');
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new HttpError(400, 'cuerpo vacío: envía los bytes del archivo');
      }
      const dir = store.uploadsDir(req.params.id);
      await fs.mkdir(dir, { recursive: true });
      const name = await uniqueUploadName(dir, sanitizeUploadName(req.query.name));
      await fs.writeFile(path.join(dir, name), req.body);
      const headerType = (req.get('content-type') || '').split(';')[0].trim();
      const type = headerType && headerType !== 'application/octet-stream' ? headerType : mimeFromName(name);
      res.status(201).json({
        name,
        path: path.join(dir, name),
        url: `/api/chats/${req.params.id}/uploads/${encodeURIComponent(name)}`,
        size: req.body.length,
        type,
      });
    })
  );

  router.get(
    '/chats/:id/uploads/:name',
    wrap(async (req, res) => {
      const name = req.params.name;
      if (typeof name !== 'string' || !UPLOAD_NAME_RE.test(name)) throw new HttpError(400, 'nombre inválido');
      const filePath = path.join(store.uploadsDir(req.params.id), name);
      // Los adjuntos se sirven desde el mismo origen que la app: sin esto un .html/.svg subido
      // podría ejecutar scripts como si fuera la propia app (XSS almacenado).
      const headers = {
        'Cache-Control': 'private, max-age=86400',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      };
      if (ACTIVE_CONTENT_EXT.has(path.extname(name).toLowerCase())) {
        headers['Content-Type'] = 'application/octet-stream';
        headers['Content-Disposition'] = `attachment; filename="${name.replace(/["\\]/g, '_')}"`;
      }
      await new Promise((resolve, reject) => {
        res.sendFile(filePath, { headers }, (err) => {
          if (!err) return resolve();
          if (err.code === 'ENOENT' || err.status === 404) return reject(new HttpError(404, 'adjunto no encontrado'));
          reject(err);
        });
      });
    })
  );

  // -- POST /chats/:id/stop ---------------------------------------------------

  router.post(
    '/chats/:id/stop',
    wrap(async (req, res) => {
      const runner = await manager.getRunner(req.params.id);
      await runner.stop();
      res.status(204).end();
    })
  );

  // -- GET /chats/:id/log ------------------------------------------------------

  router.get(
    '/chats/:id/log',
    wrap(async (req, res) => {
      await store.getChat(req.params.id); // 404 si no existe
      let limit = Number.parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) limit = 500;
      if (limit > 5000) limit = 5000;
      const entries = await store.readLogTail(req.params.id, limit);
      res.json({ entries });
    })
  );

  // -- GET /agy/conversations -------------------------------------------------

  router.get(
    '/agy/conversations',
    wrap(async (req, res) => {
      const limit = Number.parseInt(req.query.limit, 10) || 50;
      const conversations = await transcript.listConversations(limit);
      res.json(conversations);
    })
  );

  // -- error handler ------------------------------------------------------

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error('[chat] error no controlado:', err);
    res.status(500).json({ error: 'error interno del servidor' });
  });

  return router;
}

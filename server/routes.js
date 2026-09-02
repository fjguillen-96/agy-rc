// server/routes.js
// Router REST según §4 del PLAN.

import express from 'express';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { buildId } from './build.js';
import { restAuth } from './auth.js';
import * as sessions from './sessions.js';
import * as agy from './agy.js';
import { HttpError } from './sessions.js';
import { transcribeAudioWithGemini } from './transcribe.js';

const execFileAsync = promisify(execFile);

export const router = express.Router();

// PUT /chats/:id/uploads y POST /transcribe llevan el archivo crudo en el cuerpo:
// aquí no deben pasar por express.json (ni por su límite de 256 kb).
const jsonBody = express.json({ limit: '256kb' });
export const isUploadRequest = (req) =>
  (req.method === 'PUT' && /^\/chats\/[^/]+\/uploads$/.test(req.path)) ||
  (req.method === 'POST' && req.path === '/transcribe');
router.use(restAuth);
router.use((req, res, next) => {
  if (isUploadRequest(req)) return next();
  jsonBody(req, res, (err) => {
    if (err) {
      // body-parser distingue 413 (demasiado grande) / 415 de un JSON malformado (400).
      const status = err.status === 413 || err.status === 415 ? err.status : 400;
      return res.status(status).json({ error: status === 400 ? 'invalid JSON payload' : err.message });
    }
    next();
  });
});

function wrap(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// -- health -------------------------------------------------------------

router.get(
  '/health',
  wrap(async (req, res) => {
    let tmuxOk = false;
    try {
      await execFileAsync('tmux', ['-V']);
      tmuxOk = true;
    } catch {
      tmuxOk = false;
    }

    let agyOk = false;
    try {
      const cmdBasename = path.basename(config.AGY_CMD);
      await execFileAsync('which', [cmdBasename]);
      agyOk = true;
    } catch {
      agyOk = false;
    }

    res.json({
      ok: true,
      version: config.version,
      build: buildId,
      tmux: tmuxOk,
      agy: agyOk,
      uptime: process.uptime(),
    });
  })
);

// -- config ---------------------------------------------------------------

router.get(
  '/config',
  wrap(async (req, res) => {
    res.json({
      projectsRoot: config.AGY_PROJECTS_ROOT,
      defaultCmd: config.AGY_CMD,
      hasGeminiKey: Boolean(config.GEMINI_API_KEY),
    });
  })
);

// -- transcribe (Gemini 3.5 Transcribe) ------------------------------------

router.post(
  '/transcribe',
  express.raw({ type: () => true, limit: '25mb' }),
  wrap(async (req, res) => {
    if (!config.GEMINI_API_KEY) {
      throw new HttpError(400, 'GEMINI_API_KEY no configurada');
    }
    const mime = req.headers['content-type'] || 'audio/webm';
    const result = await transcribeAudioWithGemini(req.body, mime);
    res.json(result);
  })
);

// -- dirs -------------------------------------------------------------------

router.get(
  '/dirs',
  wrap(async (req, res) => {
    const raw = typeof req.query.path === 'string' ? req.query.path.trim() : '';
    let base;
    if (!raw) {
      base = config.AGY_PROJECTS_ROOT;
      try {
        await fs.access(base);
      } catch {
        base = os.homedir();
      }
    } else {
      base = await sessions.validateCwd(raw);
    }

    let entries = [];
    try {
      entries = await fs.readdir(base, { withFileTypes: true });
    } catch {
      entries = [];
    }

    const dirs = entries
      .filter((e) => {
        try {
          return e.isDirectory();
        } catch {
          return false;
        }
      })
      .map((e) => e.name)
      .filter((name) => !name.startsWith('.') && name !== 'node_modules')
      .sort((a, b) => a.localeCompare(b));

    const home = os.homedir();
    let display = base;
    if (base === home) {
      display = '~';
    } else if (base.startsWith(home + path.sep)) {
      display = '~' + base.slice(home.length);
    }

    const parsed = path.parse(base);
    const parent = base === parsed.root ? null : path.dirname(base);

    res.json({
      path: base,
      display,
      parent,
      dirs,
    });
  })
);

router.post(
  '/dirs',
  wrap(async (req, res) => {
    const { parent, name, git } = req.body || {};
    const created = await sessions.createDir({ parent: typeof parent === 'string' ? parent : '', name, git: Boolean(git) });
    res.status(201).json(created);
  })
);

// Telemetría mínima del cliente (errores JS y arranque) → journal. Sin persistencia.
const clientLogBuckets = new Map(); // ip → timestamps (rate limit 30/min)
router.post(
  '/client-log',
  wrap(async (req, res) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const bucket = (clientLogBuckets.get(ip) || []).filter((t) => now - t < 60_000);
    if (bucket.length >= 30) {
      res.status(429).end();
      return;
    }
    bucket.push(now);
    clientLogBuckets.set(ip, bucket);
    const { type, message, stack, url, ms, extra } = req.body || {};
    const ua = String(req.headers['user-agent'] || '').slice(0, 160);
    const line = [
      `[client:${String(type || 'log').slice(0, 20)}]`,
      ip,
      ms !== undefined ? `${Math.round(Number(ms))}ms` : '',
      String(message || '').slice(0, 300),
      url ? `@ ${String(url).slice(0, 120)}` : '',
      extra ? JSON.stringify(extra).slice(0, 300) : '',
      `ua="${ua}"`,
    ].filter(Boolean).join(' ');
    console.log(line);
    if (stack) console.log('  ' + String(stack).slice(0, 600).replace(/\n/g, '\n  '));
    res.status(204).end();
  })
);

router.get(
  '/browse',
  wrap(async (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    res.json(await sessions.browse(rel));
  })
);

router.get(
  '/agy/models',
  wrap(async (req, res) => {
    const models = await agy.listModels();
    res.json({ models });
  })
);

// Comandos "/" de agy ofrecidos en el compositor del chat (integrados + skills instaladas).
router.get(
  '/agy/commands',
  wrap(async (req, res) => {
    res.json({ commands: await agy.listChatCommands() });
  })
);

// -- error handler ------------------------------------------------------

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('[agy-rc] error no controlado:', err);
  res.status(500).json({ error: 'error interno del servidor' });
});

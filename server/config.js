// server/config.js
// Configuración centralizada leída de process.env con valores por defecto.
// Todas las rutas se resuelven a absolutas respecto a la raíz del repo (no a cwd).

import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// server/ está un nivel por debajo de la raíz del repo.
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');

const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.PORT, 10) || 8787;
const AGY_TOKEN = process.env.AGY_TOKEN || '';
const AGY_CMD = process.env.AGY_CMD || 'agy';
const AGY_PROJECTS_ROOT = path.resolve(process.env.AGY_PROJECTS_ROOT || path.join(os.homedir(), 'projects'));
const AGY_DATA_DIR = path.resolve(rootDir, process.env.AGY_DATA_DIR || './data');
const AGY_TMUX_SOCKET = process.env.AGY_TMUX_SOCKET || 'agyrc';
const tmuxConf = path.join(rootDir, 'scripts', 'tmux.conf');

// Shell por defecto para las sesiones tmux que lanza el chat (ver server/tmux.js).
const shell = process.env.SHELL || '/bin/bash';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

export const config = {
  HOST,
  PORT,
  AGY_TOKEN,
  AGY_CMD,
  AGY_PROJECTS_ROOT,
  AGY_TMUX_SOCKET,
  AGY_DATA_DIR,
  GEMINI_API_KEY,
  tmuxConf,
  rootDir,
  publicDir,
  version: pkg.version,
  shell,
};

// server/sessions.js
// Validación de rutas/nombres y navegador de carpetas de AGY_PROJECTS_ROOT.
// (El resto de este módulo —store de sesiones tmux, CRUD de sesiones— se eliminó junto
// con el modo terminal; lo que queda lo siguen usando server/routes.js y server/chat/*.)

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * Normaliza un nombre libre a un slug `[a-z0-9-]{1,32}`.
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  let s = String(name || '').toLowerCase();
  s = s.replace(/[\s_]+/g, '-');
  s = s.replace(/[^a-z0-9-]/g, '');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  s = s.slice(0, 32);
  s = s.replace(/-+$/g, '');
  if (!s) throw new HttpError(400, 'nombre inválido: el slug resultante está vacío');
  return s;
}

/**
 * Resuelve y valida un cwd (relativo a projectsRoot, ~ o ruta absoluta).
 * No restringe a projectsRoot para permitir trabajar en cualquier carpeta del sistema.
 * @param {string} cwd
 * @returns {Promise<string>} ruta absoluta validada
 */
export async function validateCwd(cwd) {
  const root = config.AGY_PROJECTS_ROOT;
  const raw = String(cwd || '').trim();
  let resolved;

  if (!raw || raw === '.') {
    resolved = root;
  } else if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    resolved = path.resolve(os.homedir(), raw.slice(1).replace(/^[/\\]+/, ''));
  } else if (path.isAbsolute(raw)) {
    resolved = path.resolve(raw);
  } else {
    resolved = path.resolve(root, raw);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new HttpError(400, 'cwd fuera de AGY_PROJECTS_ROOT');
    }
  }

  let st;
  try {
    st = await fs.stat(resolved);
  } catch {
    throw new HttpError(400, 'cwd no existe');
  }
  if (!st.isDirectory()) {
    throw new HttpError(400, 'cwd no es un directorio');
  }
  return resolved;
}

/**
 * Lista carpetas y ficheros (no ocultos, sin node_modules) de una ruta relativa a projectsRoot.
 * @param {string} rel
 */
export async function browse(rel) {
  const root = config.AGY_PROJECTS_ROOT;
  const base = await validateCwd(rel || '.');
  const entries = await fs.readdir(base, { withFileTypes: true });
  const visible = entries.filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules');
  const dirs = visible.filter((e) => e.isDirectory()).map((e) => ({ name: e.name }));
  const files = await Promise.all(
    visible.filter((e) => e.isFile()).map(async (e) => {
      try {
        const st = await fs.stat(path.join(base, e.name));
        return { name: e.name, size: st.size, mtime: st.mtime.toISOString() };
      } catch {
        return { name: e.name, size: null, mtime: null };
      }
    })
  );
  const byName = (a, b) => a.name.localeCompare(b.name);
  dirs.sort(byName);
  files.sort(byName);
  const relOut = path.relative(root, base);
  const parent = relOut === '' ? null : path.dirname(relOut) === '.' ? '' : path.dirname(relOut);
  return { path: relOut, absolute: base, parent, dirs, files };
}

const DIRNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Crea una carpeta nueva dentro de projectsRoot (opcionalmente con `git init`).
 * @param {{parent:string, name:string, git?:boolean}} opts parent relativo a projectsRoot
 * @returns {Promise<{path:string, absolute:string}>}
 */
export async function createDir({ parent, name, git = false }) {
  if (typeof name !== 'string' || !DIRNAME_RE.test(name)) {
    throw new HttpError(400, 'nombre de carpeta inválido (letras, números, . _ -; sin empezar por punto)');
  }
  const base = await validateCwd(parent || '.');
  const target = path.join(base, name);
  try {
    await fs.mkdir(target);
  } catch (err) {
    if (err && err.code === 'EEXIST') throw new HttpError(409, 'la carpeta ya existe');
    throw err;
  }
  if (git) {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('git', ['init', '-q'], { cwd: target }).catch(() => {
      /* sin git instalado: la carpeta ya está creada */
    });
  }
  return { path: path.relative(config.AGY_PROJECTS_ROOT, target), absolute: target };
}

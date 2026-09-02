// server/build.js
// Identificador de build del frontend: hash del contenido de public/ (ruta + bytes) calculado
// al arrancar. Sirve para (1) que el cliente detecte que hay una versión nueva desplegada
// (/api/health → build) y (2) nombrar la caché del service worker sin subir versiones a mano.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * @param {string} [publicDir]
 * @returns {string} 10 hex chars (sha1 truncado) + versión del package
 */
export function computeBuildId(publicDir = config.publicDir) {
  const h = createHash('sha1');
  h.update(config.version);
  for (const file of walk(publicDir)) {
    h.update(path.relative(publicDir, file));
    h.update(readFileSync(file));
  }
  return `${config.version}-${h.digest('hex').slice(0, 10)}`;
}

export const buildId = computeBuildId();

/**
 * Sirve public/sw.js con el nombre de caché ligado al build actual, así cada despliegue
 * invalida la caché anterior sin editar el fichero.
 * @param {string} source contenido de public/sw.js
 * @param {string} build
 */
export function renderServiceWorker(source, build) {
  return source.replace(/const CACHE_NAME = '[^']*';/, `const CACHE_NAME = 'agyrc-${build}';`);
}

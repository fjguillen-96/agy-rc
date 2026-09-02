// server/tmux.js
// Wrapper fino sobre el binario tmux vía execFile (nunca exec con string). Servidor tmux dedicado
// (`-L agyrc`, scripts/tmux.conf) donde viven los procesos agy de los chats (ver chat/tmux-proc.js).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

/**
 * Ejecuta `tmux -L <socket> -f <conf> <subcmd...>`.
 * @param {string[]} args
 * @returns {Promise<{stdout:string, stderr:string}>}
 */
export async function runTmux(args) {
  const fullArgs = ['-L', config.AGY_TMUX_SOCKET, '-f', config.tmuxConf, ...args];
  return execFileAsync('tmux', fullArgs, { maxBuffer: 10 * 1024 * 1024 });
}

/**
 * single-quote POSIX quoting: envuelve en comillas simples, escapando
 * comillas simples internas como '\'' .
 * @param {string} s
 * @returns {string}
 */
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Target de sesión con match exacto por nombre, para pasar a `-t`.
 *
 * El prefijo `=` de tmux fuerza match exacto en el ÚLTIMO componente que se está resolviendo
 * (sesión/ventana/pane): para comandos de sesión (has-session, kill-session) `=id` basta, pero
 * para los que targetean pane tmux buscaría un *pane* llamado `id`. Añadir `:` fuerza que el
 * componente exacto sea la sesión (verificado con tmux 3.7b real). Vale para todos los casos.
 * @param {string} id
 * @returns {string}
 */
export function target(id) {
  return `=${id}:`;
}

/**
 * Nombres de las sesiones vivas en el socket configurado. [] si no hay servidor (no lanza).
 * @returns {Promise<string[]>}
 */
export async function listSessionNames() {
  try {
    const { stdout } = await runTmux(['list-sessions', '-F', '#{session_name}']);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    const msg = String(err?.stderr || err?.message || '');
    if (/no server running|no current session|no sessions|error connecting to/i.test(msg)) {
      return [];
    }
    throw err;
  }
}

/**
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function hasSession(id) {
  try {
    await runTmux(['has-session', '-t', target(id)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Argv de `new-session` para lanzar `command` (UNA cadena ya citada; tmux la pasa a `sh -c`)
 * en una sesión detached. Pura, para poder testear sin invocar tmux.
 * @param {{id:string, cwd:string, command:string}} opts
 * @returns {string[]}
 */
export function buildNewSessionArgs({ id, cwd, command }) {
  return ['new-session', '-d', '-s', id, '-c', cwd, '-x', '200', '-y', '50', '--', command];
}

/**
 * Crea una sesión tmux nueva en modo detached.
 * @param {{id:string, cwd:string, command:string}} opts
 */
export async function newSession(opts) {
  await runTmux(buildNewSessionArgs(opts));
}

/**
 * @param {string} id
 */
export async function killSession(id) {
  await runTmux(['kill-session', '-t', target(id)]);
}

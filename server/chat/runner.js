// server/chat/runner.js
// ChatRunner: gestiona el proceso `agy` de larga vida de un chat (spawn,
// parseo NDJSON de stdout, estado, turnos). ChatManager: registro de
// runners por chat + broadcast a los WS suscritos.
//
// En producción el proceso corre dentro de tmux (ver tmux-proc.js): sobrevive a reinicios de
// agy-rc y el servidor lo re-adopta al arrancar (ChatManager.restoreAll → ChatRunner.attach)
// gracias al estado `chat.proc` persistido (sesión, pid y offsets de lectura).

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError } from '../sessions.js';
import * as store from './store.js';
import * as transcript from './transcript.js';
import { resolveModelId } from '../agy.js';
import { TmuxProcess } from './tmux-proc.js';
import * as tmux from '../tmux.js';

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const KILL_GRACE_MS = 1000;
const MAX_TOOL_OUTPUT_BYTES = 20 * 1024;
const BROADCAST_THROTTLE_MS = 60;
const RAW_THROTTLE_MS = 100;
const PROC_SAVE_THROTTLE_MS = 300; // persistencia de chat.proc (offsets) mientras llega salida
const EXIT_WAIT_MS = 2000; // espera a que el proceso anterior termine antes de relanzar (mismos ficheros)
const THINKING_RETRY_DELAYS_MS = [400, 1500]; // el intento a 0 ms se hace inline en handleAgentResponse
// Chars seguros sin comillas en el registro crudo (`cmd`), igual que ARG_RE de sessions.js.
const SAFE_SHELL_ARG_RE = /^[\w@%+=:,./-]+$/;

// -- summary de herramientas (puro, exportado para tests) -------------------

function truncate(s, max = 120) {
  const str = String(s ?? '');
  return str.length > max ? str.slice(0, max) : str;
}

function firstStringParam(params) {
  if (!params || typeof params !== 'object') return '';
  for (const v of Object.values(params)) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

function firstOf(params, keys) {
  if (!params || typeof params !== 'object') return undefined;
  for (const k of keys) {
    if (typeof params[k] === 'string') return params[k];
  }
  return undefined;
}

/**
 * Calcula el `summary` de una herramienta según §2.1 de CHAT.md.
 * @param {string} name tool_name
 * @param {object} [params] tool_info.parameters
 * @returns {string}
 */
export function summarizeTool(name, params) {
  switch (name) {
    case 'run_command':
      return truncate(params && params.CommandLine);
    case 'view_file':
    case 'write_to_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'sed_file': {
      const p = firstOf(params, ['AbsolutePath', 'TargetFile', 'FilePath']);
      return truncate(p !== undefined ? p : firstStringParam(params));
    }
    case 'list_dir':
      return truncate(params && params.DirectoryPath);
    case 'grep_search':
    case 'find_by_name': {
      const p = firstOf(params, ['Query', 'Pattern', 'SearchDirectory']);
      return truncate(p !== undefined ? p : firstStringParam(params));
    }
    case 'read_url_content':
    case 'search_web': {
      const p = firstOf(params, ['Url', 'query']);
      return truncate(p !== undefined ? p : firstStringParam(params));
    }
    default:
      return truncate(firstStringParam(params));
  }
}

export function systemMessage(kind, text, id) {
  return {
    id: id || `s-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    ts: Date.now(),
    role: 'system',
    text,
    kind,
  };
}

/**
 * Shell-quote simple de un arg para el registro crudo (`cmd`): comillas simples
 * si tiene espacios o chars fuera de `[\w@%+=:,./-]`, tal cual sin comillar si no.
 * @param {string} arg
 * @returns {string}
 */
function shellQuoteArg(arg) {
  const s = String(arg);
  if (s === '') return "''";
  return SAFE_SHELL_ARG_RE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function shellQuoteArgv(argv) {
  return argv.map(shellQuoteArg).join(' ');
}

/** Espera `ms` sin retener el event loop (para reintentos de attachThinking). */
function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

// -- ChatRunner ---------------------------------------------------------

const UPLOAD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$/;
const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4a: 'audio/mp4', mp3: 'audio/mpeg',
  pdf: 'application/pdf', json: 'application/json', txt: 'text/plain', md: 'text/markdown',
  csv: 'text/csv', html: 'text/html', js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python',
  zip: 'application/zip',
};

/**
 * Tipo MIME aproximado por extensión (para la miniatura de la burbuja de usuario).
 * @param {string} name
 * @returns {string}
 */
export function mimeFromName(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

/**
 * Comprueba que los adjuntos existen en la carpeta de subidas del chat y devuelve sus metadatos.
 * @param {string} chatId
 * @param {unknown} attachments nombres de archivo (tal como los devolvió PUT /uploads)
 * @returns {Promise<Array<{name:string,path:string,url:string,type:string,size:number}>>}
 */
export async function resolveAttachments(chatId, attachments) {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments) || attachments.length > 10) {
    throw new HttpError(400, 'attachments debe ser una lista de hasta 10 nombres de archivo');
  }
  const dir = store.uploadsDir(chatId);
  const out = [];
  for (const name of attachments) {
    if (typeof name !== 'string' || !UPLOAD_NAME_RE.test(name)) {
      throw new HttpError(400, 'nombre de adjunto inválido');
    }
    const filePath = path.join(dir, name);
    let st;
    try {
      st = await fs.promises.stat(filePath);
    } catch {
      throw new HttpError(400, `el adjunto "${name}" no existe; súbelo primero`);
    }
    if (!st.isFile()) throw new HttpError(400, `el adjunto "${name}" no es un archivo`);
    out.push({
      name,
      path: filePath,
      url: `/api/chats/${chatId}/uploads/${encodeURIComponent(name)}`,
      type: mimeFromName(name),
      size: st.size,
    });
  }
  return out;
}

/**
 * Prompt que se envía a agy: el texto del usuario más las rutas de los adjuntos (stream-json
 * solo acepta bloques de texto; agy lee imágenes y archivos con view_file por ruta).
 * @param {string} text
 * @param {Array<{path:string}>} files
 * @returns {string}
 */
export function composePrompt(text, files) {
  if (!files || files.length === 0) return text;
  const list = files.map((f) => `- ${f.path}`).join('\n');
  const head = text ? `${text}\n\n` : '';
  return `${head}[Archivos adjuntos por el usuario — rutas absolutas; usa view_file para verlos]\n${list}`;
}

export class ChatRunner extends EventEmitter {
  /**
   * @param {object} chat meta del chat (mutable, ver store.js)
   * @param {{spawnImpl?: Function, resolveModel?: Function}} [opts] `spawnImpl(cmd, args, options)` → child-process-like
   *   (sync o Promise; solo tests: sin él, el proceso se lanza en tmux con TmuxProcess);
   *   `resolveModel(modelId, effort)` → id para `--model` (sync o Promise; por defecto resolveModelId de agy.js)
   */
  constructor(chat, opts = {}) {
    super();
    this.chat = chat;
    this.spawnImpl = opts.spawnImpl || null;
    this.resolveModel = opts.resolveModel || resolveModelId;
    this.proc = null;
    this.alive = false;
    this.exitHandled = false;
    this.stoppedByUser = false;
    this.turnActive = false;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.openAgentResponses = new Map(); // id -> {text, sawDelta}
    this.lastMessages = new Map(); // id -> último Msg upsert-eado (para no pisar interrupted, etc. desde attachThinking)
    this.resumed = false; // true si el chat ya tenía conversationId ANTES del spawn() actual
    this.idleTimer = null;
    this.killTimer = null;
    this.procSaveTimer = null;
    // Se marca en dispose() (DELETE del chat): el proceso recién matado puede seguir
    // escribiendo NDJSON un instante (p.ej. un `result` de error final tras el kill,
    // visto en la práctica: "stream input cancelled"). Sin esto, ese evento tardío
    // resucitaría el .ndjson/.json del chat ya borrado vía upsert()/persistChat().
    this.disposed = false;
    this.pending = new Set(); // trabajo async en curso disparado desde callbacks de streams (para tests: flush())
    // Cola que serializa el procesamiento de eventos NDJSON en orden estricto de llegada.
    // Necesaria: `upsert()` hace I/O async (fs.appendFile) y dos eventos de la misma línea
    // de chunk (p.ej. tool ACTIVE seguido de tool DONE, mismo id) podrían, sin esto,
    // completar su escritura en orden distinto al de llegada y emitirse/difundirse desordenados.
    this.eventQueue = Promise.resolve();
  }

  /**
   * Registra una promesa de trabajo en curso disparado desde un callback de
   * stream (no awaited por su llamador). Permite a los tests esperar a que
   * el procesamiento asíncrono en vuelo termine con `flush()`.
   * @param {Promise} promise
   * @returns {Promise}
   */
  trackPending(promise) {
    this.pending.add(promise);
    const clear = () => this.pending.delete(promise);
    promise.then(clear, clear);
    return promise;
  }

  /** Espera a que todo el trabajo async en curso termine (uso en tests). */
  async flush() {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  // -- estado -------------------------------------------------------------

  setState(state) {
    if (this.chat.state === state) return;
    this.chat.state = state;
    this.chat.updatedAt = new Date().toISOString();
    this.emit('state', state);
    if (this.disposed) return;
    // Persistencia en segundo plano (no bloquea el emit en vivo): sin esto, `state` en
    // disco solo se actualizaba cuando otro campo (conversationId, lastMessageAt…)
    // disparaba persistChat() por coincidencia, dejando GET /api/chats/:id con un
    // `state` obsoleto (p.ej. "starting" para siempre en turnos ya resueltos).
    this.trackPending(
      store.saveChat(this.chat).catch((err) => {
        console.error(`[chat:${this.chat.id}] error persistiendo state:`, err);
      })
    );
  }

  async persistChat(patch) {
    if (this.disposed) return;
    Object.assign(this.chat, patch, { updatedAt: new Date().toISOString() });
    await store.saveChat(this.chat);
    this.emit('chat', this.chat);
  }

  async upsert(message) {
    if (this.disposed) return;
    this.lastMessages.set(message.id, message);
    await store.appendMessage(this.chat.id, message);
    this.emit('message', message);
  }

  /**
   * Registra una entrada del registro crudo del CLI (§"Registro crudo" de
   * docs/CHAT.md): la emite de inmediato (para `raw-sub` por WS, ver
   * ChatManager.broadcastRawEntry) y la persiste en `data/chats/<id>.log`.
   * @param {'cmd'|'out'|'err'|'sys'} src
   * @param {string} line
   */
  rawLog(src, line) {
    const entry = { ts: Date.now(), src, line };
    this.emit('raw', entry);
    if (this.disposed) return entry;
    this.trackPending(
      store.appendLog(this.chat.id, entry).catch((err) => {
        console.error(`[chat:${this.chat.id}] error escribiendo registro crudo:`, err);
      })
    );
    return entry;
  }

  /**
   * Marca el runner como desechado (chat borrado): a partir de aquí, cualquier
   * evento tardío del proceso ya matado (stdout/stderr en vuelo) se ignora sin
   * tocar disco. Ver comentario del campo `disposed` en el constructor.
   */
  dispose() {
    this.disposed = true;
    this.clearIdleTimer();
    this.clearKillTimer();
    if (this.procSaveTimer) {
      clearTimeout(this.procSaveTimer);
      this.procSaveTimer = null;
    }
  }

  isAlive() {
    return this.alive && this.proc != null;
  }

  // -- ciclo de vida del proceso -------------------------------------------

  /**
   * @param {string|null} [resolvedModel] id ya resuelto para el esfuerzo (ver resolveModelId);
   *   si se omite se usa `chat.model` tal cual (tests / sin catálogo).
   */
  buildArgv(resolvedModel = this.chat.model) {
    const argv = [
      config.AGY_CMD,
      '-p=',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--print-timeout',
      '60m',
      // Sin esto, las herramientas de agy corren en ~/.gemini/antigravity-cli/scratch en vez
      // de this.chat.cwd (aunque `init.cwd` reporte el cwd correcto): bug verificado en
      // docs/CHAT.md §1 ("me dice que no está en ningún directorio").
      '--add-dir',
      this.chat.cwd,
      // Carpeta de adjuntos del chat (fotos/archivos subidos desde la app): agy los lee con
      // view_file por ruta absoluta, así que debe estar en su workspace.
      '--add-dir',
      store.uploadsDir(this.chat.id),
    ];
    // `--model <id>` y `--effort` juntos son inválidos para agy (el id ya lleva el esfuerzo):
    // con modelo se pasa solo el id resuelto para ese esfuerzo; sin modelo, solo --effort.
    if (resolvedModel) argv.push('--model', resolvedModel);
    else if (this.chat.effort) argv.push('--effort', this.chat.effort);
    if (this.chat.mode && this.chat.mode !== 'normal') argv.push('--mode', this.chat.mode);
    if (this.chat.autoApprove) argv.push('--dangerously-skip-permissions');
    if (this.chat.conversationId) argv.push('--conversation', this.chat.conversationId);
    if (this.chat.newProject) argv.push('--new-project');
    return argv;
  }

  buildEnv() {
    const localBin = path.join(os.homedir(), '.local', 'bin');
    return { ...process.env, PATH: `${localBin}:${process.env.PATH || ''}` };
  }

  async spawn() {
    // Debe leerse ANTES de que este spawn (re)lance el proceso: handleInit lo usa para
    // decidir si el mensaje system de arranque dice "reanudado" (ver docs/CHAT.md §1/§2.1).
    this.resumed = Boolean(this.chat.conversationId);
    // Si resolveModel es sincrónico no hay await: el spawn queda síncrono hasta spawnImpl (tests).
    const resolvedOrPromise = this.resolveModel(this.chat.model, this.chat.effort);
    const resolved = resolvedOrPromise && typeof resolvedOrPromise.then === 'function' ? await resolvedOrPromise : resolvedOrPromise;
    this.spawnedModel = resolved || null; // id realmente pasado en --model (para el mensaje de arranque)
    const argv = this.buildArgv(resolved);
    // Síncrono a propósito: spawn() debe seguir siendo síncrono hasta spawnImpl (ver arriba).
    try {
      fs.mkdirSync(store.uploadsDir(this.chat.id), { recursive: true });
    } catch (err) {
      console.error(`[chat:${this.chat.id}] no se pudo crear la carpeta de adjuntos:`, err);
    }
    this.rawLog('cmd', `${shellQuoteArgv(argv)} # cwd=${this.chat.cwd}`);
    let child;
    if (this.spawnImpl) {
      child = this.spawnImpl(argv[0], argv.slice(1), {
        cwd: this.chat.cwd,
        env: this.buildEnv(),
      });
      if (child && typeof child.then === 'function') child = await child;
    } else {
      // El anterior (matado por stop()/restart()) comparte los ficheros .out/.err: esperar a que
      // termine antes de truncarlos, o su tail leería la salida del nuevo desde un offset viejo.
      await this.waitForExit();
      child = await TmuxProcess.spawn(this.chat.id, argv, { cwd: this.chat.cwd });
    }
    this.adoptProcess(child);
    this.rawLog('sys', `spawn pid=${child.pid ?? '?'}`);
    console.log(`[chat:${this.chat.id}] spawn agy pid=${child.pid ?? '?'} cwd=${this.chat.cwd}`);
    return child;
  }

  /**
   * Re-adopta el proceso tmux de este chat tras un reinicio del servidor, a partir del estado
   * `chat.proc` persistido. Si la sesión ya terminó mientras el servidor no estaba, TmuxProcess
   * drena igualmente el resto de la salida (y el marcador de salida) y se cierra el turno.
   * @returns {Promise<boolean>} true si había algo que adoptar
   */
  async attach() {
    const saved = this.chat.proc;
    if (!saved || this.isAlive()) return false;
    this.resumed = true;
    this.rawLog('sys', `attach ${saved.session} pid=${saved.pid ?? '?'} (reinicio del servidor)`);
    console.log(`[chat:${this.chat.id}] re-adoptando ${saved.session} pid=${saved.pid ?? '?'} out@${saved.outOffset}`);
    // Si el chat quedó en starting/running hay un turno abierto cuyo final llegará por .out.
    this.turnActive = this.chat.state === 'running' || this.chat.state === 'starting';
    if (this.turnActive) await this.seedOpenAssistants();
    this.adoptProcess(TmuxProcess.attach(this.chat.id, saved));
    if (!this.turnActive) this.scheduleIdleTimeout();
    return true;
  }

  /**
   * Recupera del ndjson los mensajes de asistente sin cerrar (`done:false`) para que los deltas
   * que sigan llegando tras un attach() continúen su texto en vez de empezar de cero.
   */
  async seedOpenAssistants() {
    const messages = await store.readMessages(this.chat.id).catch(() => []);
    for (const m of messages) {
      if (m.role === 'assistant' && m.done === false) {
        this.openAgentResponses.set(m.id, { text: m.text || '', sawDelta: Boolean(m.text) });
        this.lastMessages.set(m.id, m);
      }
    }
  }

  /** Espera (con tope) a que el proceso actual, si lo hay, termine de salir. */
  async waitForExit() {
    if (!this.proc) return;
    const deadline = Date.now() + EXIT_WAIT_MS;
    while (this.proc && Date.now() < deadline) {
      await delay(50);
    }
    if (this.proc) {
      console.warn(`[chat:${this.chat.id}] el proceso anterior no terminó a tiempo; se da por perdido`);
      this.finalizeExit(null);
    }
  }

  /**
   * Engancha un proceso (recién lanzado o re-adoptado) a los manejadores de salida/salida-de-proceso.
   * @param {object} child child-process-like (TmuxProcess o fake de tests)
   */
  adoptProcess(child) {
    this.proc = child;
    this.alive = true;
    this.exitHandled = false;
    this.stoppedByUser = false;
    this.stdoutBuf = '';
    this.stderrBuf = '';

    if (child instanceof TmuxProcess) {
      this.chat.proc = child.snapshot();
      this.saveProcState(true);
      child.on('pid', () => this.saveProcState(true));
      child.on('offset', () => this.saveProcState(false));
    }

    if (child.stdout) {
      if (typeof child.stdout.setEncoding === 'function') child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    }
    if (child.stderr) {
      if (typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => this.handleStderr(chunk));
    }
    child.once('exit', (code) => this.finalizeExit(code));
    child.once('error', (err) => {
      console.error(`[chat:${this.chat.id}] error de proceso: ${err && err.message}`);
      this.finalizeExit(null);
    });
  }

  /**
   * Persiste `chat.proc` (sesión tmux, pid, offsets leídos) para poder re-adoptar el proceso tras
   * un reinicio. Los offsets cambian con cada trozo de salida: se agrupan (throttle) salvo `now`.
   * Sin emitir 'chat' (los offsets no interesan a los clientes).
   * @param {boolean} now
   */
  saveProcState(now) {
    if (this.disposed) return;
    const write = () => {
      this.procSaveTimer = null;
      if (this.disposed) return;
      if (this.proc instanceof TmuxProcess && !this.proc.exited) this.chat.proc = this.proc.snapshot();
      this.trackPending(
        store.saveChat(this.chat).catch((err) => {
          console.error(`[chat:${this.chat.id}] error persistiendo estado del proceso:`, err);
        })
      );
    };
    if (now) {
      if (this.procSaveTimer) clearTimeout(this.procSaveTimer);
      write();
      return;
    }
    if (this.procSaveTimer) return;
    this.procSaveTimer = setTimeout(write, PROC_SAVE_THROTTLE_MS);
    if (typeof this.procSaveTimer.unref === 'function') this.procSaveTimer.unref();
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  scheduleIdleTimeout() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.isAlive() && !this.turnActive) {
        console.log(`[chat:${this.chat.id}] idle-timeout 15min, matando proceso`);
        this.rawLog('sys', 'idle-timeout');
        this.killProcess();
      }
    }, IDLE_TIMEOUT_MS);
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  clearKillTimer() {
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  killProcess() {
    if (!this.proc) return;
    const proc = this.proc;
    try {
      proc.kill('SIGTERM');
    } catch {
      // ya muerto
    }
    this.clearKillTimer();
    this.killTimer = setTimeout(() => {
      try {
        if (this.proc === proc && this.alive) proc.kill('SIGKILL');
      } catch {
        // ya muerto
      }
    }, KILL_GRACE_MS);
    if (typeof this.killTimer.unref === 'function') this.killTimer.unref();
  }

  // -- envío de turnos ------------------------------------------------------

  /**
   * Envía un mensaje de usuario. Lanza el proceso si no está vivo.
   * @param {string} text
   * @param {string[]} [attachments] nombres de archivos ya subidos a `uploadsDir(chat.id)`
   * @returns {Promise<object>} el mensaje de usuario persistido
   */
  async send(text, attachments = []) {
    if (this.turnActive) {
      throw new HttpError(409, 'ya hay un turno en curso en este chat');
    }
    this.turnActive = true;
    try {
      // Se valida ANTES de tocar el estado: un adjunto inexistente no debe dejar el chat en 'starting'.
      // Sin adjuntos no hay await: send() sigue siendo síncrono hasta spawnImpl (tests).
      const hasAttachments = attachments !== undefined && attachments !== null && !(Array.isArray(attachments) && attachments.length === 0);
      const files = hasAttachments ? await resolveAttachments(this.chat.id, attachments) : [];
      if (!text && files.length === 0) throw new HttpError(400, 'mensaje vacío');

      const wasAlive = this.isAlive();
      if (!wasAlive) {
        this.setState('starting');
        await this.spawn();
      } else {
        this.clearIdleTimer();
        this.setState('running');
      }

    const userMsg = {
      id: `u-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      ts: Date.now(),
      role: 'user',
      text,
    };
    if (files.length) userMsg.attachments = files.map(({ name, url, type, size }) => ({ name, url, type, size }));
    await this.upsert(userMsg);
    const patch = { lastMessageAt: new Date(userMsg.ts).toISOString() };
    if (!this.chat.title) patch.title = store.defaultTitle(text || files[0].name);
    await this.persistChat(patch);

    const prompt = composePrompt(text, files);
    const line = JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } }) + '\n';
    // Si el proceso murió durante los await anteriores, finalizeExit ya cerró el turno con error.
    const proc = this.proc;
    if (!proc) return userMsg;
    try {
      // TmuxProcess devuelve una promesa (abre el FIFO por línea); un ChildProcess, un boolean.
      await proc.stdin.write(line);
    } catch (err) {
      console.error(`[chat:${this.chat.id}] error escribiendo a stdin:`, err);
      if (this.proc === proc) {
        this.turnActive = false;
        await this.upsert(systemMessage('error', `No se pudo enviar el mensaje a Antigravity: ${err.message}`));
        this.setState('idle');
        this.killProcess();
      }
    }
    return userMsg;
    } catch (err) {
      this.turnActive = false;
      throw err;
    }
  }

  /**
   * Detiene el turno en curso (si lo hay) y mata el proceso.
   */
  async stop() {
    if (!this.isAlive()) {
      this.turnActive = false;
      this.setState('idle');
      return;
    }
    this.stoppedByUser = true;
    await this.closeOpenAssistants({ interrupted: true });
    this.turnActive = false;
    await this.upsert(systemMessage('stopped', 'Detenido'));
    this.setState('idle');
    this.rawLog('sys', 'kill (detener)');
    this.killProcess();
  }

  /**
   * Mata el proceso actual sin marcar "Detenido"; el siguiente `send()`
   * relanza con `--conversation` y los flags actuales del chat.
   */
  async restart() {
    if (this.isAlive()) {
      this.stoppedByUser = true;
      this.restarting = true;
      this.rawLog('sys', 'restart (flags cambiados)');
      this.killProcess();
    }
    this.turnActive = false;
    this.clearIdleTimer();
    this.setState('idle');
  }

  async closeOpenAssistants(extra = {}) {
    for (const [id, entry] of this.openAgentResponses) {
      if (entry.sawDelta) {
        await this.upsert({ id, ts: Date.now(), role: 'assistant', text: entry.text, done: true, ...extra });
      }
    }
    this.openAgentResponses.clear();
  }

  // -- parseo de stdout/stderr ----------------------------------------------

  handleStdout(chunk) {
    this.stdoutBuf += chunk;
    let idx;
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx);
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      this.processStdoutLine(line);
    }
  }

  processStdoutLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.rawLog('out', trimmed);
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      console.log(`[chat:${this.chat.id}] stdout no-JSON: ${truncate(trimmed, 300)}`);
      return;
    }
    // Encadenado (no fire-and-forget) para preservar el orden de llegada aunque
    // el procesamiento de un evento involucre I/O async (ver comentario del constructor).
    this.eventQueue = this.eventQueue.then(
      () => this.handleEvent(evt),
      () => this.handleEvent(evt) // por si el eslabón previo quedó rechazado (no debería, pero no bloquear la cola)
    ).catch((err) => {
      console.error(`[chat:${this.chat.id}] error procesando evento:`, err);
    });
    this.trackPending(this.eventQueue);
  }

  handleStderr(chunk) {
    this.stderrBuf += chunk;
    let idx;
    while ((idx = this.stderrBuf.indexOf('\n')) >= 0) {
      const line = this.stderrBuf.slice(0, idx);
      this.stderrBuf = this.stderrBuf.slice(idx + 1);
      this.processStderrLine(line);
    }
  }

  processStderrLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.rawLog('err', trimmed);
    console.log(`[chat:${this.chat.id}] stderr: ${trimmed}`);
    if (/user denied permission/i.test(trimmed)) {
      this.trackPending(
        this.upsert(
          systemMessage(
            'error',
            'Antigravity denegó un permiso porque el auto-aprobado está desactivado. Activa "Auto-aprobar herramientas" en los ajustes del chat, o usa el modo Plan para revisar antes de ejecutar.'
          )
        ).catch((err) => console.error(`[chat:${this.chat.id}] error persistiendo aviso de permiso:`, err))
      );
    }
  }

  async handleEvent(evt) {
    if (!evt || typeof evt !== 'object') return;
    switch (evt.event) {
      case 'init':
        return this.handleInit(evt);
      case 'step_update':
        return this.handleStepUpdate(evt.step_update || {});
      case 'result':
        return this.handleResult(evt.result || {});
      default:
        console.log(`[chat:${this.chat.id}] evento stdout desconocido: ${String(evt.event)}`);
    }
  }

  async handleInit(evt) {
    if (evt.conversation_id && evt.conversation_id !== this.chat.conversationId) {
      await this.persistChat({ conversationId: evt.conversation_id });
    }
    if (this.chat.state === 'starting') {
      this.setState('running');
    }
    const cwd = (evt.init && evt.init.cwd) || this.chat.cwd;
    await this.upsert(systemMessage('info', this.buildInitInfoText(cwd), `sys-init-${Date.now()}`));
  }

  /**
   * Texto del system 'info' de arranque, según docs/CHAT.md §2.1: describe dónde corre agy y con
   * qué flags, para que el usuario detecte de un vistazo el bug de workspace ("no está en ningún
   * directorio") si volviera a pasar. `this.resumed` se fija en spawn() (ANTES de este init).
   * @param {string} cwd
   * @returns {string}
   */
  buildInitInfoText(cwd) {
    const prefix = this.resumed ? 'Antigravity reanudado en' : 'Antigravity en';
    const autoApprove = this.chat.autoApprove ? 'ON' : 'OFF';
    const model = this.spawnedModel || this.chat.model || 'modelo por defecto';
    const effort = this.chat.effort || 'por defecto';
    let text = `${prefix} ${cwd} · auto-aprobar ${autoApprove} · ${model} · ${effort}`;
    if (this.chat.mode === 'plan') text += ' · modo plan';
    else if (this.chat.mode === 'accept-edits') text += ' · modo aceptar ediciones';
    return text;
  }

  async handleStepUpdate(su) {
    const conversationId = su.conversation_id || this.chat.conversationId || 'na';
    switch (su.step_type) {
      case 'agent_response':
        return this.handleAgentResponse(su, conversationId);
      case 'tool':
        return this.handleTool(su, conversationId);
      case 'user_input':
      case 'unknown':
      default:
        return;
    }
  }

  async handleAgentResponse(su, conversationId) {
    const id = `a-${conversationId}-${su.step_index}`;
    let entry = this.openAgentResponses.get(id);
    if (!entry) {
      entry = { text: '', sawDelta: false };
      this.openAgentResponses.set(id, entry);
    }
    if (typeof su.text_delta === 'string' && su.text_delta.length > 0) {
      entry.text += su.text_delta;
      entry.sawDelta = true;
    }

    if (su.state === 'ACTIVE') {
      if (entry.sawDelta) {
        await this.upsert({ id, ts: Date.now(), role: 'assistant', text: entry.text, done: false });
      }
    } else if (su.state === 'DONE' || su.state === 'ERROR') {
      this.openAgentResponses.delete(id);
      const hadDelta = entry.sawDelta;
      // Primer intento de leer el thinking INLINE: agy ya ha escrito el paso en transcript.jsonl
      // cuando emite el DONE (verificado), así que casi siempre acierta y el mensaje "solo pensó"
      // queda en su sitio (antes de la tarjeta de herramienta que sigue). Solo los reintentos
      // (transcript rezagado) van fuera de la cola de eventos.
      const thinking = await transcript.readStepThinking(conversationId, su.step_index).catch(() => null);
      if (hadDelta || thinking) {
        const msg = { id, ts: Date.now(), role: 'assistant', text: entry.text, done: true };
        if (thinking) msg.thinking = thinking;
        if (su.usage) msg.usage = su.usage;
        if (typeof su.duration_seconds === 'number') msg.durationSeconds = su.duration_seconds;
        await this.upsert(msg);
      }
      if (!thinking) {
        this.trackPending(
          this.attachThinking(id, hadDelta, conversationId, su.step_index, su.usage, su.duration_seconds).catch((err) => {
            console.error(`[chat:${this.chat.id}] error adjuntando thinking:`, err);
          })
        );
      }
    }
  }

  /**
   * Intenta leer el `thinking` de un paso PLANNER_RESPONSE desde el transcript.jsonl de agy y
   * adjuntarlo al mensaje assistant correspondiente (o crear el paso "solo pensó" si no hubo
   * delta). El transcript puede tardar en escribirse tras el DONE del stream: reintenta con
   * espera creciente. Se aborta si el runner se `dispose()`a mientras tanto.
   * @param {string} id id del mensaje assistant (`a-<conv>-<step_index>`)
   * @param {boolean} hadDelta si `handleAgentResponse` ya hizo upsert de un mensaje con texto
   * @param {string} conversationId
   * @param {number} stepIndex
   * @param {object} [usage]
   * @param {number} [durationSeconds]
   */
  async attachThinking(id, hadDelta, conversationId, stepIndex, usage, durationSeconds) {
    let thinking = null;
    for (const ms of THINKING_RETRY_DELAYS_MS) {
      if (this.disposed) return;
      if (ms > 0) await delay(ms);
      if (this.disposed) return;
      thinking = await transcript.readStepThinking(conversationId, stepIndex).catch(() => null);
      if (thinking) break;
    }
    if (this.disposed || !thinking) return;

    if (hadDelta) {
      // Mensaje MÁS RECIENTE persistido para este id (podría haber cambiado, p.ej. interrupted:true
      // por un stop() mientras esperábamos el transcript): no lo pisamos con un estado obsoleto.
      const latest = this.lastMessages.get(id);
      if (!latest) return;
      await this.upsert({ ...latest, thinking });
    } else {
      const msg = { id, ts: Date.now(), role: 'assistant', text: '', done: true, thinking };
      if (usage) msg.usage = usage;
      if (typeof durationSeconds === 'number') msg.durationSeconds = durationSeconds;
      await this.upsert(msg);
    }
  }

  async handleTool(su, conversationId) {
    const id = `t-${conversationId}-${su.step_index}`;
    const toolInfo = su.tool_info || {};
    const name = su.tool_name || toolInfo.name || 'tool';
    const summary = summarizeTool(name, toolInfo.parameters);
    const base = { id, ts: Date.now(), role: 'tool', name, params: toolInfo.parameters || {}, summary };

    if (su.state === 'ACTIVE') {
      await this.upsert({ ...base, state: 'active' });
    } else if (su.state === 'DONE') {
      const msg = { ...base, state: 'done' };
      if (typeof toolInfo.output === 'string') msg.output = toolInfo.output.slice(0, MAX_TOOL_OUTPUT_BYTES);
      if (typeof su.duration_seconds === 'number') msg.durationSeconds = su.duration_seconds;
      await this.upsert(msg);
    } else if (su.state === 'ERROR') {
      const err = toolInfo.error || {};
      const errText = [err.type, err.message].filter(Boolean).join(': ') || 'error';
      await this.upsert({ ...base, state: 'error', error: errText });
    }
  }

  async handleResult(result) {
    this.turnActive = false;
    await this.closeOpenAssistants();
    if (result.conversation_id && result.conversation_id !== this.chat.conversationId) {
      await this.persistChat({ conversationId: result.conversation_id });
    }
    if (result.status === 'ERROR') {
      const isCancellation = this.stoppedByUser || this.restarting ||
        (result.error && (result.error.includes('context canceled') || result.error.includes('stream input cancelled')));
      if (!isCancellation) {
        await this.upsert(systemMessage('error', result.error || 'Error en el turno de Antigravity'));
      }
    }
    this.restarting = false;
    this.setState('idle');
    this.scheduleIdleTimeout();
  }

  // -- salida del proceso -----------------------------------------------

  finalizeExit(code) {
    if (this.exitHandled) return;
    this.exitHandled = true;
    this.alive = false;
    this.clearIdleTimer();
    this.clearKillTimer();
    // vuelca cualquier resto sin salto de línea final (mejor esfuerzo)
    if (this.stdoutBuf.trim()) this.processStdoutLine(this.stdoutBuf);
    if (this.stderrBuf.trim()) this.processStderrLine(this.stderrBuf);
    this.stdoutBuf = '';
    this.stderrBuf = '';

    this.rawLog('sys', `exit code=${code === null ? '?' : code}`);
    console.log(`[chat:${this.chat.id}] agy salió código=${code === null ? '?' : code}`);
    if (this.proc instanceof TmuxProcess) {
      this.proc.finish(code); // por si la salida la detectó el runner (error) y no el propio tail
      if (this.procSaveTimer) {
        clearTimeout(this.procSaveTimer);
        this.procSaveTimer = null;
      }
    }
    this.proc = null;

    // Encadenado tras `eventQueue`: si el buffer volcado justo arriba incluía un
    // `result` final, debe procesarse (y actualizar turnActive) antes de decidir
    // si esta salida fue "inesperada en mitad de un turno".
    this.eventQueue = this.eventQueue.then(async () => {
      const wasTurnActive = this.turnActive;
      const stoppedByUser = this.stoppedByUser;
      this.turnActive = false;
      this.stoppedByUser = false;
      try {
        await this.closeOpenAssistants({ interrupted: true });
        if (wasTurnActive && !stoppedByUser) {
          await this.upsert(systemMessage('error', `Antigravity terminó (código ${code === null ? '?' : code})`));
        }
        this.setState('idle');
        if (this.chat.proc) await this.persistChat({ proc: null });
      } catch (err) {
        console.error(`[chat:${this.chat.id}] error finalizando salida del proceso:`, err);
      }
    });
    this.trackPending(this.eventQueue);
  }
}

// -- ChatManager ----------------------------------------------------------

export class ChatManager {
  /**
   * @param {{spawnImpl?: Function, resolveModel?: Function}} [opts]
   */
  constructor(opts = {}) {
    this.spawnImpl = opts.spawnImpl;
    this.resolveModel = opts.resolveModel;
    this.runners = new Map();
    this.subscribers = new Map(); // chatId -> Set<ws>
    this.throttled = new Map(); // `${chatId}:${messageId}` -> {timer, pending}
    this.rawSubscribers = new Map(); // chatId -> Set<ws> suscritos a raw-sub (registro crudo del CLI)
    this.rawBuffers = new Map(); // chatId -> {entries:[], timer}
  }

  /**
   * Devuelve (creando si hace falta) el runner de un chat. Lanza HttpError 404
   * si el chat no existe.
   * @param {string} chatId
   * @returns {Promise<ChatRunner>}
   */
  async getRunner(chatId) {
    let runner = this.runners.get(chatId);
    if (runner) return runner;
    if (!this.loadingRunners) this.loadingRunners = new Map();
    if (this.loadingRunners.has(chatId)) {
      return this.loadingRunners.get(chatId);
    }
    const loadPromise = (async () => {
      try {
        const chat = await store.getChat(chatId);
        let existing = this.runners.get(chatId);
        if (existing) return existing;
        runner = new ChatRunner(chat, { spawnImpl: this.spawnImpl, resolveModel: this.resolveModel });
        runner.on('message', (message) => this.broadcastMessage(chatId, message));
        runner.on('state', (state) => this.broadcastRaw(chatId, { t: 'state', state }));
        runner.on('chat', (chat2) => this.broadcastRaw(chatId, { t: 'chat', chat: chat2 }));
        runner.on('raw', (entry) => this.broadcastRawEntry(chatId, entry));
        this.runners.set(chatId, runner);
        return runner;
      } finally {
        this.loadingRunners.delete(chatId);
      }
    })();
    this.loadingRunners.set(chatId, loadPromise);
    return loadPromise;
  }

  /**
   * Al arrancar el servidor: re-adopta los procesos tmux de los chats que quedaron con `proc`
   * (siguen vivos en tmux, o terminaron mientras el servidor no estaba: en ambos casos hay que
   * drenar su salida y cerrar el estado) y mata las sesiones `chat-*` huérfanas (chats borrados).
   * @returns {Promise<number>} runners re-adoptados
   */
  async restoreAll() {
    const chats = await store.listChats();
    const known = new Set(chats.map((c) => c.id));
    let restored = 0;
    for (const chat of chats) {
      if (!chat.proc) continue;
      try {
        const runner = await this.getRunner(chat.id);
        if (await runner.attach()) restored++;
      } catch (err) {
        console.error(`[chat:${chat.id}] no se pudo re-adoptar el proceso:`, err);
      }
    }
    try {
      for (const name of await tmux.listSessionNames()) {
        const m = /^chat-(.+)$/.exec(name);
        if (m && !known.has(m[1])) {
          console.log(`[chat] matando sesión tmux huérfana ${name}`);
          await tmux.killSession(name).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[chat] error listando sesiones tmux:', err);
    }
    return restored;
  }

  /**
   * Devuelve el runner ya existente en memoria, o undefined (sin crearlo).
   * @param {string} chatId
   */
  peekRunner(chatId) {
    return this.runners.get(chatId);
  }

  subscribe(chatId, ws) {
    let set = this.subscribers.get(chatId);
    if (!set) {
      set = new Set();
      this.subscribers.set(chatId, set);
    }
    set.add(ws);
  }

  unsubscribe(chatId, ws) {
    const set = this.subscribers.get(chatId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.subscribers.delete(chatId);
  }

  /**
   * Suscribe un ws al registro crudo (`raw-sub`, ver docs/CHAT.md). Sin esta suscripción, las
   * entradas `raw` NO se envían por ese ws (ahorro de datos móviles).
   * @param {string} chatId
   * @param {import('ws').WebSocket} ws
   */
  subscribeRaw(chatId, ws) {
    let set = this.rawSubscribers.get(chatId);
    if (!set) {
      set = new Set();
      this.rawSubscribers.set(chatId, set);
    }
    set.add(ws);
  }

  unsubscribeRaw(chatId, ws) {
    const set = this.rawSubscribers.get(chatId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.rawSubscribers.delete(chatId);
  }

  broadcastRaw(chatId, payload) {
    const set = this.subscribers.get(chatId);
    if (!set || set.size === 0) return;
    const data = JSON.stringify(payload);
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(data);
        } catch {
          // ignorar
        }
      }
    }
  }

  /**
   * Agrupa deltas de un mismo mensaje en ≤ 1 envío cada 60 ms (leading + trailing).
   * @param {string} chatId
   * @param {object} message
   */
  broadcastMessage(chatId, message) {
    const key = `${chatId}:${message.id}`;
    const existing = this.throttled.get(key);
    if (!existing) {
      this.broadcastRaw(chatId, { t: 'msg', message });
      const timer = setTimeout(() => {
        const cur = this.throttled.get(key);
        this.throttled.delete(key);
        if (cur && cur.pending) {
          this.broadcastRaw(chatId, { t: 'msg', message: cur.pending });
        }
      }, BROADCAST_THROTTLE_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.throttled.set(key, { timer, pending: null });
    } else {
      existing.pending = message;
    }
  }

  /**
   * Agrupa entradas `raw` (registro crudo del CLI) en ≤ 1 envío cada `RAW_THROTTLE_MS` por chat,
   * y solo a los ws suscritos vía `raw-sub` (ver docs/CHAT.md §"Registro crudo").
   * @param {string} chatId
   * @param {{ts:number, src:string, line:string}} entry
   */
  broadcastRawEntry(chatId, entry) {
    const targets = this.rawSubscribers.get(chatId);
    if (!targets || targets.size === 0) return;
    let buf = this.rawBuffers.get(chatId);
    if (!buf) {
      buf = { entries: [], timer: null };
      this.rawBuffers.set(chatId, buf);
    }
    buf.entries.push(entry);
    if (buf.timer) return;
    buf.timer = setTimeout(() => {
      this.rawBuffers.delete(chatId);
      const subs = this.rawSubscribers.get(chatId);
      if (!subs || subs.size === 0 || buf.entries.length === 0) return;
      const data = JSON.stringify({ t: 'raw', entries: buf.entries });
      for (const ws of subs) {
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(data);
          } catch {
            // ignorar
          }
        }
      }
    }, RAW_THROTTLE_MS);
    if (typeof buf.timer.unref === 'function') buf.timer.unref();
  }

  /**
   * Detiene y elimina el runner de un chat (usado por DELETE /api/chats/:id).
   * @param {string} chatId
   */
  async removeRunner(chatId) {
    const runner = this.runners.get(chatId);
    if (runner) {
      await runner.stop().catch(() => {});
      // Espera a que agy termine de verdad (marcador exit del wrapper): si deleteChat() borrara los
      // ficheros antes, el wrapper recrearía <id>.out al escribir el marcador. Acotado (EXIT_WAIT_MS).
      await runner.waitForExit().catch(() => {});
      // Drena cualquier persistencia en segundo plano que stop() haya disparado sin
      // esperar (p.ej. el guardado de estado de setState()): sin esto puede terminar
      // después de deleteChat() y resucitar el .json/.ndjson del chat recién borrado.
      await runner.flush().catch(() => {});
      runner.dispose();
      this.runners.delete(chatId);
    }
    this.subscribers.delete(chatId);
    this.rawSubscribers.delete(chatId);
    this.rawBuffers.delete(chatId);
  }
}

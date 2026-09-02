// server/chat/tmux-proc.js
// TmuxProcess: el proceso `agy` (stream-json) de un chat corriendo DENTRO de una sesión tmux
// (socket `-L agyrc`), desligado del servidor: sobrevive a reinicios de agy-rc y el servidor lo
// re-adopta con `attach()`. Expone la misma interfaz child-process-like que usa ChatRunner
// (`stdout`/`stderr` con 'data', 'exit', 'error', `pid`, `kill()`, `stdin.write()`), pero por
// debajo:
//   - stdin  → FIFO `data/chats/<id>.in` (el servidor abre O_WRONLY|O_NONBLOCK por línea)
//   - stdout → fichero append `data/chats/<id>.out`, que se "tailea" por offset (fs.watch + sondeo)
//   - stderr → fichero append `data/chats/<id>.err`, ídem
// El wrapper scripts/chat-agy.sh deja en `.out` dos marcadores `{"agyrc":"spawn","pid"}` y
// `{"agyrc":"exit","code"}` que aquí se interceptan (no llegan al parser NDJSON del runner).

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import * as tmux from '../tmux.js';
import * as store from './store.js';

const execFileAsync = promisify(execFile);

const WRAPPER = path.join(config.rootDir, 'scripts', 'chat-agy.sh');
const POLL_MS = 150; // sondeo de los ficheros (fs.watch es el camino rápido; esto, la red de seguridad)
const ALIVE_CHECK_MS = 5000; // comprobación de que la sesión tmux sigue viva (por si no llega el marcador exit)
const WRITE_RETRY_MS = 20; // FIFO lleno (EAGAIN): margen antes de reintentar
const OPEN_RETRY_MS = 50; // FIFO aún sin lector (ENXIO): agy arrancando dentro de tmux
const WRITE_MAX_WAIT_MS = 15_000;
const KILL_CHECK_MS = 1500; // tras kill(): comprobar pronto si la sesión murió sin dejar marcador

/** Nombre de la sesión tmux del chat. */
export function sessionName(chatId) {
  return `chat-${chatId}`;
}

/**
 * Compone la línea de comando (una sola cadena, tmux la pasa a `sh -c`) que ejecuta el wrapper.
 * Pura, exportada para tests.
 * @param {{fifo:string,out:string,err:string}} paths
 * @param {string[]} argv comando agy completo
 * @returns {string}
 */
export function buildWrapperCommand(paths, argv) {
  return [WRAPPER, paths.fifo, paths.out, paths.err, ...argv].map(tmux.shq).join(' ');
}

function isMarker(obj) {
  return obj && typeof obj === 'object' && typeof obj.agyrc === 'string';
}

/** Espera `ms`. Mantiene vivo el event loop: se usa en medio de escrituras pendientes. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TmuxProcess extends EventEmitter {
  /**
   * No usar directamente: ver `TmuxProcess.spawn()` y `TmuxProcess.attach()`.
   * @param {string} chatId
   * @param {{fifo:string,out:string,err:string}} paths
   */
  constructor(chatId, paths) {
    super();
    this.chatId = chatId;
    this.tmuxSession = sessionName(chatId);
    this.paths = paths;
    this.pid = null; // pid de agy (del marcador spawn o del estado persistido)
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { write: (line) => this.writeStdin(line) };
    // Bytes ya consumidos de cada fichero (solo avanzan hasta el último '\n' completo).
    this.offsets = { out: 0, err: 0 };
    this.alive = false;
    this.exited = false;
    this.exitCode = undefined;
    this.watchers = [];
    this.pollTimer = null;
    this.aliveTimer = null;
    this.reading = null; // promesa del readAll() en curso (serializa lecturas)
    this.readAgain = false;
  }

  // -- construcción ---------------------------------------------------------

  /**
   * Lanza `argv` dentro de una sesión tmux nueva `chat-<id>` y empieza a seguir su salida.
   * @param {string} chatId
   * @param {string[]} argv
   * @param {{cwd:string}} opts
   * @returns {Promise<TmuxProcess>}
   */
  static async spawn(chatId, argv, { cwd }) {
    const paths = store.procPaths(chatId);
    await fs.promises.mkdir(path.dirname(paths.out), { recursive: true });
    await ensureFifo(paths.fifo);
    // Ficheros nuevos por lanzamiento: los offsets empiezan en 0.
    await fs.promises.writeFile(paths.out, '');
    await fs.promises.writeFile(paths.err, '');
    const proc = new TmuxProcess(chatId, paths);
    if (await tmux.hasSession(proc.tmuxSession)) {
      // Resto de un lanzamiento anterior que nadie adoptó: no puede haber dos agy por chat.
      await tmux.killSession(proc.tmuxSession).catch(() => {});
    }
    await tmux.newSession({
      id: proc.tmuxSession,
      cwd,
      command: buildWrapperCommand(paths, argv),
    });
    proc.startTail();
    return proc;
  }

  /**
   * Re-adopta el proceso de un chat tras un reinicio del servidor. Si la sesión tmux ya no existe,
   * igualmente drena lo que quedara sin leer en los ficheros (incluido el marcador de salida) y
   * emite 'exit'.
   * @param {string} chatId
   * @param {{pid?:number|null, outOffset?:number, errOffset?:number}} saved estado persistido en chat.proc
   * @returns {TmuxProcess}
   */
  static attach(chatId, saved = {}) {
    const proc = new TmuxProcess(chatId, store.procPaths(chatId));
    proc.pid = typeof saved.pid === 'number' ? saved.pid : null;
    proc.offsets.out = Number.isInteger(saved.outOffset) && saved.outOffset >= 0 ? saved.outOffset : 0;
    proc.offsets.err = Number.isInteger(saved.errOffset) && saved.errOffset >= 0 ? saved.errOffset : 0;
    proc.startTail();
    return proc;
  }

  // -- seguimiento de ficheros ------------------------------------------------

  startTail() {
    this.alive = true;
    for (const key of ['out', 'err']) {
      try {
        const w = fs.watch(this.paths[key], { persistent: false }, () => this.scheduleRead());
        w.on('error', () => {});
        this.watchers.push(w);
      } catch {
        // sin inotify seguimos con el sondeo
      }
    }
    this.pollTimer = setInterval(() => this.scheduleRead(), POLL_MS);
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref();
    this.aliveTimer = setInterval(() => this.checkAlive(), ALIVE_CHECK_MS);
    if (typeof this.aliveTimer.unref === 'function') this.aliveTimer.unref();
    // Diferido: quien nos construye aún tiene que enganchar sus manejadores de 'data'/'exit'.
    setImmediate(() => this.scheduleRead());
  }

  stopTail() {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignorar
      }
    }
    this.watchers = [];
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.aliveTimer) clearInterval(this.aliveTimer);
    this.pollTimer = null;
    this.aliveTimer = null;
  }

  /** Lanza un readAll() si no hay otro en curso; si lo hay, pide que se repita al terminar. */
  scheduleRead() {
    if (this.exited) return this.reading || Promise.resolve();
    if (this.reading) {
      this.readAgain = true;
      return this.reading;
    }
    this.reading = this.readAll()
      .catch((err) => {
        console.error(`[chat:${this.chatId}] error leyendo la salida de tmux:`, err);
      })
      .then(() => {
        this.reading = null;
        if (this.readAgain) {
          this.readAgain = false;
          return this.scheduleRead();
        }
        return undefined;
      });
    return this.reading;
  }

  /** Lee los bytes nuevos de .out y .err, emite las líneas completas y actualiza los offsets. */
  async readAll() {
    let advanced = false;
    let exitCode;
    for (const key of ['out', 'err']) {
      const chunk = await readNewLines(this.paths[key], this.offsets[key]);
      if (!chunk) continue;
      this.offsets[key] += chunk.bytes;
      advanced = true;
      if (key === 'err') {
        this.stderr.emit('data', chunk.text);
        continue;
      }
      // stdout: interceptar marcadores del wrapper; el resto va tal cual al runner
      const passthrough = [];
      for (const line of chunk.text.split('\n')) {
        if (!line.trim()) continue;
        let obj = null;
        if (line.startsWith('{"agyrc"')) {
          try {
            obj = JSON.parse(line);
          } catch {
            obj = null;
          }
        }
        if (isMarker(obj)) {
          if (obj.agyrc === 'spawn' && Number.isInteger(obj.pid)) {
            this.pid = obj.pid;
            this.emit('pid', this.pid);
          } else if (obj.agyrc === 'exit') {
            exitCode = Number.isInteger(obj.code) ? obj.code : null;
          }
          continue;
        }
        passthrough.push(line);
      }
      if (passthrough.length) this.stdout.emit('data', passthrough.join('\n') + '\n');
    }
    if (advanced) this.emit('offset', { out: this.offsets.out, err: this.offsets.err });
    if (exitCode !== undefined) this.finish(exitCode);
  }

  async checkAlive() {
    if (this.exited) return;
    if (await tmux.hasSession(this.tmuxSession)) return;
    // La sesión murió: apurar lo que quede en los ficheros (normalmente incluye el marcador exit).
    await this.scheduleRead();
    if (!this.exited) {
      console.warn(`[chat:${this.chatId}] la sesión tmux ${this.tmuxSession} desapareció sin marcador de salida`);
      this.finish(null);
    }
  }

  finish(code) {
    if (this.exited) return;
    this.exited = true;
    this.alive = false;
    this.exitCode = code;
    this.stopTail();
    this.emit('exit', code);
  }

  // -- stdin / señales --------------------------------------------------------

  /**
   * Escribe una línea en el FIFO. Falla (rechaza) si agy ya no lo está leyendo.
   * Justo tras spawn() el wrapper aún puede no haber abierto el FIFO (ENXIO): se reintenta
   * mientras el proceso no haya terminado.
   * @param {string} line
   * @returns {Promise<void>}
   */
  async writeStdin(line) {
    const deadline = Date.now() + WRITE_MAX_WAIT_MS;
    let fd;
    for (;;) {
      if (this.exited) throw new Error('Antigravity ya terminó');
      try {
        fd = await fs.promises.open(this.paths.fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
        break;
      } catch (err) {
        if (!(err && err.code === 'ENXIO')) throw err;
        if (Date.now() >= deadline) throw new Error('Antigravity no está leyendo (¿ha terminado el proceso?)');
        await delay(OPEN_RETRY_MS);
      }
    }
    try {
      const buf = Buffer.from(line, 'utf8');
      let written = 0;
      while (written < buf.length) {
        try {
          const { bytesWritten } = await fd.write(buf, written, buf.length - written);
          written += bytesWritten;
        } catch (err) {
          if (err && err.code === 'EAGAIN' && Date.now() < deadline) {
            await delay(WRITE_RETRY_MS);
            continue;
          }
          if (err && err.code === 'EPIPE') throw new Error('Antigravity cerró la entrada (¿ha terminado el proceso?)');
          throw err;
        }
      }
    } finally {
      await fd.close().catch(() => {});
    }
  }

  /**
   * Manda una señal a agy (por pid). Sin pid conocido, mata la sesión tmux (el wrapper reenvía
   * SIGTERM a agy). Devuelve una promesa que no hace falta esperar (interfaz child-process-like).
   * @param {NodeJS.Signals} [signal]
   */
  async kill(signal = 'SIGTERM') {
    if (this.exited) return;
    // Si el wrapper murió antes de instalar su trampa (kill nada más lanzar) no habrá marcador
    // exit: comprobar la sesión antes de lo que tardaría el sondeo periódico.
    const t = setTimeout(() => this.checkAlive(), KILL_CHECK_MS);
    if (typeof t.unref === 'function') t.unref();

    // Sin sesión tmux el pid guardado es de otra vida (reinicio del equipo): jamás señalarlo,
    // podría pertenecer ahora a cualquier otro proceso del usuario.
    const sessionExists = await tmux.hasSession(this.tmuxSession).catch(() => false);
    if (!sessionExists) {
      this.finish(null);
      return;
    }

    if (this.pid) {
      try {
        process.kill(this.pid, signal);
        return;
      } catch (err) {
        if (err && err.code === 'ESRCH') return;
      }
    }
    await tmux.killSession(this.tmuxSession).catch(() => {});
  }

  /** Estado a persistir en `chat.proc` para poder re-adoptar el proceso tras un reinicio. */
  snapshot() {
    return {
      session: this.tmuxSession,
      pid: this.pid,
      outOffset: this.offsets.out,
      errOffset: this.offsets.err,
    };
  }
}

// -- utilidades de fichero -------------------------------------------------

async function ensureFifo(fifoPath) {
  try {
    const st = await fs.promises.stat(fifoPath);
    if (st.isFIFO()) return;
    await fs.promises.rm(fifoPath, { force: true });
  } catch {
    // no existe
  }
  await execFileAsync('mkfifo', ['-m', '600', fifoPath]);
}

/**
 * Lee desde `offset` hasta el último '\n' disponible. Devuelve null si no hay ninguna línea
 * completa nueva.
 * @param {string} file
 * @param {number} offset
 * @returns {Promise<{text:string, bytes:number}|null>}
 */
async function readNewLines(file, offset) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (size <= offset) return null;
    const buf = Buffer.alloc(size - offset);
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    if (bytesRead === 0) return null;
    const lastNl = buf.lastIndexOf(0x0a, bytesRead - 1);
    if (lastNl < 0) return null;
    return { text: buf.toString('utf8', 0, lastNl + 1), bytes: lastNl + 1 };
  } finally {
    await fh.close().catch(() => {});
  }
}

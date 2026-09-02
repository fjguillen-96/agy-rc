// Tests del proceso agy de un chat dentro de tmux (server/chat/tmux-proc.js + ChatRunner sin
// spawnImpl): usan un servidor tmux real con socket propio y un agy falso (test/fixtures/fake-agy.sh)
// que imita el protocolo stream-json. Cubren el lanzamiento, el FIFO de stdin, los marcadores del
// wrapper, la persistencia de `chat.proc` y la re-adopción tras un "reinicio" del servidor.

process.env.AGY_TOKEN = '';
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGY = path.join(here, 'fixtures', 'fake-agy.sh');

let dataDir;
let socket;
let store;
let tmux;
let TmuxProcess;
let ChatRunner;
let ChatManager;

const identityModel = (model) => model || null;

function until(fn, { timeout = 8000, step = 40, what = 'condición' } = {}) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      let ok;
      try {
        ok = await fn();
      } catch (err) {
        reject(err);
        return;
      }
      if (ok) {
        resolve(ok);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timeout esperando: ${what}`));
        return;
      }
      setTimeout(tick, step);
    };
    tick();
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runner con captura de mensajes/estados emitidos. */
function instrument(runner) {
  const messages = [];
  const states = [];
  runner.on('message', (m) => messages.push(m));
  runner.on('state', (s) => states.push(s));
  return { messages, states };
}

function lastAssistant(messages) {
  const byId = new Map();
  for (const m of messages) byId.set(m.id, m);
  return [...byId.values()].filter((m) => m.role === 'assistant').pop();
}

/** Simula la muerte del servidor: deja de seguir la salida y olvida el runner SIN matar agy. */
function abandon(runner) {
  const proc = runner.proc;
  proc.stopTail();
  proc.removeAllListeners();
  proc.stdout.removeAllListeners();
  proc.stderr.removeAllListeners();
  runner.dispose();
  return proc;
}

before(async () => {
  socket = `agyrc-chat-test-${process.pid}`;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-rc-chat-tmux-'));
  process.env.AGY_TMUX_SOCKET = socket;
  process.env.AGY_DATA_DIR = dataDir;
  process.env.AGY_CMD = FAKE_AGY;
  process.env.AGY_PROJECTS_ROOT = dataDir;

  store = await import('../server/chat/store.js');
  tmux = await import('../server/tmux.js');
  ({ TmuxProcess } = await import('../server/chat/tmux-proc.js'));
  ({ ChatRunner, ChatManager } = await import('../server/chat/runner.js'));
});

after(async () => {
  await execFileAsync('tmux', ['-L', socket, 'kill-server']).catch(() => {});
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('TmuxProcess', () => {
  test('lanza el comando en una sesión tmux, lee stdout/stderr por ficheros y escribe por el FIFO', async () => {
    const chatId = 'c_tmuxproc01';
    const proc = await TmuxProcess.spawn(chatId, [FAKE_AGY], { cwd: dataDir });
    const out = [];
    const err = [];
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => err.push(d));
    let exit;
    proc.once('exit', (code) => {
      exit = { code };
    });

    assert.equal(proc.tmuxSession, `chat-${chatId}`);
    assert.ok(await tmux.hasSession(proc.tmuxSession), 'la sesión tmux existe');
    await until(() => proc.pid !== null, { what: 'marcador spawn con pid' });
    assert.ok(proc.pid > 0);
    await until(() => out.join('').includes('"event":"init"'), { what: 'init del agy falso' });
    assert.ok(!out.join('').includes('"agyrc"'), 'los marcadores del wrapper no llegan a stdout');

    await proc.stdin.write(JSON.stringify({ event: 'user', message: { role: 'user', content: 'stderr hola' } }) + '\n');
    await until(() => out.join('').includes('"text_delta":"stderr hola"'), { what: 'eco por stdout' });
    await until(() => err.join('').includes('ruido en stderr'), { what: 'stderr por fichero' });

    const snap = proc.snapshot();
    assert.equal(snap.session, `chat-${chatId}`);
    assert.equal(snap.pid, proc.pid);
    assert.ok(snap.outOffset > 0 && snap.errOffset > 0);

    proc.kill('SIGTERM');
    await until(() => exit !== undefined, { what: 'exit tras SIGTERM' });
    assert.equal(typeof exit.code, 'number');
    assert.equal(proc.exited, true);
    await until(async () => !(await tmux.hasSession(proc.tmuxSession)), { what: 'sesión tmux cerrada' });
    await assert.rejects(() => proc.stdin.write('x\n'), /ya terminó|no está leyendo|cerró la entrada/);
  });

  test('attach() drena lo pendiente desde el offset guardado, incluido el marcador de salida', async () => {
    const chatId = 'c_tmuxproc02';
    const proc = await TmuxProcess.spawn(chatId, [FAKE_AGY], { cwd: dataDir });
    const seen = [];
    proc.stdout.on('data', (d) => seen.push(d));
    await until(() => proc.pid !== null && seen.join('').includes('"event":"init"'), { what: 'init' });
    const saved = proc.snapshot();
    // "muere el servidor": dejamos de leer, pero el proceso sigue; luego agy termina solo
    proc.stopTail();
    proc.removeAllListeners();
    proc.stdout.removeAllListeners();
    await proc.stdin.write(JSON.stringify({ event: 'user', message: { role: 'user', content: 'quit' } }) + '\n');
    await until(async () => !(await tmux.hasSession(proc.tmuxSession)), { what: 'agy falso terminó' });

    const again = TmuxProcess.attach(chatId, saved);
    const out2 = [];
    again.stdout.on('data', (d) => out2.push(d));
    const code = await new Promise((resolve) => again.once('exit', resolve));
    assert.equal(code, 3, 'el marcador exit trae el código real del agy falso');
    assert.ok(!out2.join('').includes('"event":"init"'), 'no se re-lee lo ya consumido antes del offset');
    assert.equal(again.pid, saved.pid);
  });
});

describe('ChatRunner sobre tmux', () => {
  test('send() lanza agy en tmux, persiste chat.proc y completa el turno', async () => {
    const chat = await store.createChat({ cwd: dataDir, title: 'pw-test tmux' });
    const runner = new ChatRunner(chat, { resolveModel: identityModel });
    const { messages, states } = instrument(runner);

    await runner.send('hola');
    assert.ok(runner.proc instanceof TmuxProcess);
    assert.ok(await tmux.hasSession(`chat-${chat.id}`));

    await until(() => states.includes('idle') && lastAssistant(messages)?.done === true, { what: 'turno completado' });
    assert.equal(lastAssistant(messages).text, 'eco: hola');
    assert.equal(chat.conversationId, 'conv-fake');
    assert.ok(messages.some((m) => m.kind === 'info' && /Antigravity en/.test(m.text)), 'system info de arranque');

    await runner.flush();
    const saved = await store.getChat(chat.id);
    assert.equal(saved.state, 'idle');
    assert.equal(saved.proc.session, `chat-${chat.id}`);
    assert.ok(saved.proc.pid > 0);
    assert.ok(saved.proc.outOffset > 0, 'offset de lectura persistido');

    await runner.stop();
    await until(() => runner.proc === null, { what: 'proceso cerrado tras stop' });
    await runner.flush();
    assert.equal((await store.getChat(chat.id)).proc, null, 'chat.proc se limpia al salir');
    assert.ok(!(await tmux.hasSession(`chat-${chat.id}`)));
    runner.dispose();
  });

  test('un turno en vuelo sobrevive al "reinicio" del servidor y se re-adopta con restoreAll()', async () => {
    const chat = await store.createChat({ cwd: dataDir, title: 'pw-test reinicio' });
    const runner = new ChatRunner(chat, { resolveModel: identityModel });
    const { messages } = instrument(runner);
    await runner.send('slow uno');
    await until(() => messages.some((m) => m.kind === 'info'), { what: 'init procesado' });
    await runner.flush();
    assert.equal((await store.getChat(chat.id)).state, 'running');

    // el servidor "muere" con la respuesta aún pendiente (el agy falso tarda 1,5 s)
    const orphan = abandon(runner);
    assert.ok(await tmux.hasSession(`chat-${chat.id}`), 'agy sigue vivo en tmux sin servidor');

    // arranca un servidor nuevo
    const manager = new ChatManager({ resolveModel: identityModel });
    const restored = await manager.restoreAll();
    assert.equal(restored, 1);
    const runner2 = manager.peekRunner(chat.id);
    assert.ok(runner2 && runner2.isAlive(), 'runner re-adoptado y vivo');
    assert.equal(runner2.turnActive, true, 'sabe que hay un turno en curso');
    const { messages: messages2 } = instrument(runner2);

    await until(() => runner2.chat.state === 'idle' && lastAssistant(messages2)?.done === true, { what: 'turno terminado tras el reinicio' });
    assert.equal(lastAssistant(messages2).text, 'eco: slow uno');
    assert.ok(!messages2.some((m) => m.kind === 'error'), 'sin errores espurios');
    assert.equal(runner2.proc.pid, orphan.pid, 'mismo proceso agy');

    // y el chat sigue operativo con el mismo proceso
    await runner2.send('dos');
    await until(() => lastAssistant(messages2)?.text === 'eco: dos' && lastAssistant(messages2).done, { what: 'segundo turno' });

    await manager.removeRunner(chat.id);
    await until(async () => !(await tmux.hasSession(`chat-${chat.id}`)), { what: 'sesión cerrada' });
  });

  test('si agy murió mientras el servidor no estaba, attach() cierra el turno con error y limpia proc', async () => {
    const chat = await store.createChat({ cwd: dataDir, title: 'pw-test muerto' });
    const runner = new ChatRunner(chat, { resolveModel: identityModel });
    const { messages } = instrument(runner);
    await runner.send('slow quit'); // el agy falso espera 1,5 s y sale con código 3
    await until(() => messages.some((m) => m.kind === 'info'), { what: 'init' });
    await runner.flush();
    const orphan = abandon(runner);
    await until(async () => !(await tmux.hasSession(`chat-${chat.id}`)), { what: 'agy falso salió' });
    assert.ok(orphan.pid > 0);

    const manager = new ChatManager({ resolveModel: identityModel });
    await manager.restoreAll();
    const runner2 = manager.peekRunner(chat.id);
    await until(() => runner2.chat.state === 'idle' && runner2.proc === null, { what: 'salida procesada' });
    await runner2.flush();
    // Se comprueba en el store y no con instrument(): la salida puede procesarse dentro del propio
    // restoreAll() (durante la limpieza de huérfanas), antes de que nadie escuche al runner.
    const messages2 = await store.readMessages(chat.id);
    assert.ok(messages2.some((m) => m.kind === 'error' && /terminó \(código 3\)/.test(m.text)), 'error de salida inesperada');
    assert.equal((await store.getChat(chat.id)).proc, null);
  });

  test('restoreAll() mata sesiones chat-* huérfanas de chats ya borrados', async () => {
    const chatId = 'c_huerfano01';
    const proc = await TmuxProcess.spawn(chatId, [FAKE_AGY], { cwd: dataDir });
    await until(() => proc.pid !== null, { what: 'pid' });
    proc.stopTail();
    const manager = new ChatManager({ resolveModel: identityModel });
    await manager.restoreAll();
    await until(async () => !(await tmux.hasSession(`chat-${chatId}`)), { what: 'huérfana eliminada' });
  });

  test('DELETE del chat (removeRunner + deleteChat con agy vivo) borra también los ficheros del proceso', async () => {
    const manager = new ChatManager({ resolveModel: identityModel });
    const chat = await store.createChat({ cwd: dataDir, title: 'pw-test borrar' });
    const runner = await manager.getRunner(chat.id);
    await runner.send('hola');
    await until(() => runner.chat.state === 'idle', { what: 'turno' });
    const paths = store.procPaths(chat.id);
    await fs.access(paths.fifo);
    assert.ok(runner.isAlive());
    // Misma secuencia que la ruta DELETE /chats/:id: removeRunner debe esperar al marcador exit
    // del wrapper; si no, éste recrearía <id>.out después del borrado.
    await manager.removeRunner(chat.id);
    await store.deleteChat(chat.id);
    await delay(500); // margen para que un marcador exit tardío recreara <id>.out
    for (const p of Object.values(paths)) {
      await assert.rejects(() => fs.access(p), { code: 'ENOENT' });
    }
    await until(async () => !(await tmux.hasSession(`chat-${chat.id}`)), { what: 'sesión cerrada' });
  });
});

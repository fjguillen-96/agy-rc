import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// En tests no hay catálogo de modelos de agy: el id se pasa tal cual (sincrónico → spawn síncrono).
const identityModel = (modelId) => modelId || null;
import http from 'node:http';

let dataDir;
let projectsRoot;
let homeDir;
let realHome;

let summarizeTool;
let ChatRunner;
let ChatManager;
let store;
let transcript;
let createApp;
let composePrompt;
let resolveAttachments;
let sanitizeUploadName;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-rc-chat-test-'));
  projectsRoot = path.join(dataDir, 'projects');
  homeDir = path.join(dataDir, 'home');
  await fs.mkdir(projectsRoot, { recursive: true });
  await fs.mkdir(path.join(projectsRoot, 'proyecto-a'), { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });

  process.env.AGY_PROJECTS_ROOT = projectsRoot;
  process.env.AGY_DATA_DIR = dataDir;
  process.env.AGY_TMUX_SOCKET = 'agyrc-chat-unused-in-unit-tests';
  process.env.AGY_TOKEN = '';
  process.env.HOST = '127.0.0.1';
  process.env.PORT = '0';

  realHome = process.env.HOME;
  process.env.HOME = homeDir; // aísla transcript.js (os.homedir()) del $HOME real durante todo el fichero

  ({ summarizeTool, ChatRunner, ChatManager, composePrompt, resolveAttachments } = await import('../server/chat/runner.js'));
  ({ sanitizeUploadName } = await import('../server/chat/routes.js'));
  store = await import('../server/chat/store.js');
  transcript = await import('../server/chat/transcript.js');
  ({ createApp } = await import('../server/index.js'));
});

after(async () => {
  if (realHome !== undefined) process.env.HOME = realHome;
  await fs.rm(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake child process (para inyectar como spawnImpl en ChatRunner)
// ---------------------------------------------------------------------------

function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  const written = [];
  child.stdin = {
    write(s) {
      written.push(s);
      return true;
    },
  };
  child.stdin.written = written;
  child.kill = (signal) => {
    child.killed = true;
    child.lastSignal = signal;
  };
  return child;
}

function makeSpawnImpl() {
  const calls = [];
  const spawnImpl = (cmd, args, options) => {
    const child = makeFakeChild();
    calls.push({ cmd, args, options, child });
    return child;
  };
  spawnImpl.calls = calls;
  return spawnImpl;
}

function baseChat(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id || `c_${Math.random().toString(16).slice(2, 12).padEnd(10, '0')}`,
    title: '',
    cwd: path.join(projectsRoot, 'proyecto-a'),
    model: null,
    effort: null,
    mode: 'normal',
    autoApprove: true,
    newProject: false,
    conversationId: null,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: null,
    state: 'idle',
    ...overrides,
  };
}

function sendLine(child, obj) {
  child.stdout.emit('data', JSON.stringify(obj) + '\n');
}

// ---------------------------------------------------------------------------
// summarizeTool (puro)
// ---------------------------------------------------------------------------

describe('summarizeTool', () => {
  test('run_command → CommandLine', () => {
    assert.equal(summarizeTool('run_command', { CommandLine: 'echo TOOL_OK' }), 'echo TOOL_OK');
  });

  test('view_file → AbsolutePath', () => {
    assert.equal(summarizeTool('view_file', { AbsolutePath: '/home/x/file.js' }), '/home/x/file.js');
  });

  test('write_to_file → TargetFile', () => {
    assert.equal(summarizeTool('write_to_file', { TargetFile: '/tmp/out.txt', Content: 'hola' }), '/tmp/out.txt');
  });

  test('list_dir → DirectoryPath', () => {
    assert.equal(summarizeTool('list_dir', { DirectoryPath: '/tmp' }), '/tmp');
  });

  test('grep_search → Query', () => {
    assert.equal(summarizeTool('grep_search', { Query: 'TODO', SearchDirectory: '/tmp' }), 'TODO');
  });

  test('find_by_name → Pattern (sin Query)', () => {
    assert.equal(summarizeTool('find_by_name', { Pattern: '*.js' }), '*.js');
  });

  test('search_web → query', () => {
    assert.equal(summarizeTool('search_web', { query: 'antigravity cli' }), 'antigravity cli');
  });

  test('read_url_content → Url', () => {
    assert.equal(summarizeTool('read_url_content', { Url: 'https://example.com' }), 'https://example.com');
  });

  test('otros → primer valor string, truncado a 120', () => {
    const long = 'x'.repeat(200);
    assert.equal(summarizeTool('ask_question', { Question: long }).length, 120);
  });

  test('sin parámetro reconocible → cadena vacía', () => {
    assert.equal(summarizeTool('run_command', {}), '');
    assert.equal(summarizeTool('run_command', undefined), '');
  });
});

// ---------------------------------------------------------------------------
// ChatRunner: parseo de eventos NDJSON → mensajes (muestras de CHAT.md §1)
// ---------------------------------------------------------------------------

describe('ChatRunner: parseo de eventos', () => {
  test('agent_response con deltas → mensaje assistant acumulado y done', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });

    const messages = [];
    const states = [];
    runner.on('message', (m) => messages.push(m));
    runner.on('state', (s) => states.push(s));

    const sendPromise = runner.send('Recuerda la palabra clave MANZANA. Responde solo: ok');
    assert.equal(runner.chat.state, 'starting');
    const child = spawnImpl.calls[0].child;
    assert.equal(spawnImpl.calls[0].cmd, 'agy');
    assert.ok(spawnImpl.calls[0].args.includes('--dangerously-skip-permissions'));

    sendLine(child, {
      event: 'init',
      conversation_id: '11111111-1111-4111-8111-111111111111',
      init: { cwd: chat.cwd, tools: [], permission_mode: 'request-review' },
    });
    await runner.flush();
    assert.equal(runner.chat.state, 'running');
    assert.equal(runner.chat.conversationId, '11111111-1111-4111-8111-111111111111');

    sendLine(child, {
      event: 'step_update',
      step_update: {
        conversation_id: '11111111-1111-4111-8111-111111111111',
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: 'Hola',
      },
    });
    sendLine(child, {
      event: 'step_update',
      step_update: {
        conversation_id: '11111111-1111-4111-8111-111111111111',
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: ' mundo',
      },
    });
    sendLine(child, {
      event: 'step_update',
      step_update: {
        conversation_id: '11111111-1111-4111-8111-111111111111',
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: '\n',
        duration_seconds: 1.2,
        usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 },
      },
    });
    await runner.flush();

    const assistantMsgs = messages.filter((m) => m.role === 'assistant');
    assert.ok(assistantMsgs.length >= 3);
    const last = assistantMsgs[assistantMsgs.length - 1];
    assert.equal(last.text, 'Hola mundo\n');
    assert.equal(last.done, true);
    assert.equal(last.usage.total_tokens, 15);
    assert.equal(last.durationSeconds, 1.2);
    assert.equal(last.id, 'a-11111111-1111-4111-8111-111111111111-1');

    sendLine(child, {
      event: 'result',
      result: {
        conversation_id: '11111111-1111-4111-8111-111111111111',
        status: 'SUCCESS',
        response: 'Hola mundo\n',
        duration_seconds: 1.5,
        num_turns: 1,
        usage: {},
      },
    });
    await runner.flush();
    await sendPromise;

    assert.equal(runner.chat.state, 'idle');
    assert.deepEqual(states, ['starting', 'running', 'idle']);
    assert.ok(!messages.some((m) => m.role === 'system' && m.kind === 'error'));

    runner.clearIdleTimer();
  });

  test('agent_response DONE sin text_delta (solo pensó) no crea burbuja', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    runner.on('message', (m) => messages.push(m));

    await runner.send('hola');
    const child = spawnImpl.calls[0].child;
    sendLine(child, {
      event: 'step_update',
      step_update: { conversation_id: 'c1', step_index: 0, state: 'ACTIVE', step_type: 'agent_response' },
    });
    sendLine(child, {
      event: 'step_update',
      step_update: { conversation_id: 'c1', step_index: 0, state: 'DONE', step_type: 'agent_response' },
    });
    await runner.flush();

    assert.equal(messages.filter((m) => m.role === 'assistant').length, 0);
    runner.clearIdleTimer();
  });

  test('tool ACTIVE → DONE con output truncado, resumen y duración', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    runner.on('message', (m) => messages.push(m));

    await runner.send('ejecuta algo');
    const child = spawnImpl.calls[0].child;

    sendLine(child, {
      event: 'step_update',
      step_update: {
        conversation_id: 'c2',
        step_index: 3,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo TOOL_OK' } },
      },
    });
    await runner.flush();
    let toolMsgs = messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 1);
    assert.equal(toolMsgs[0].state, 'active');
    assert.equal(toolMsgs[0].summary, 'echo TOOL_OK');
    assert.equal(toolMsgs[0].id, 't-c2-3');

    const bigOutput = 'A'.repeat(25 * 1024) + 'TOOL_OK';
    sendLine(child, {
      event: 'step_update',
      step_update: {
        conversation_id: 'c2',
        step_index: 3,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo TOOL_OK' }, output: bigOutput },
        duration_seconds: 0.4,
      },
    });
    await runner.flush();
    toolMsgs = messages.filter((m) => m.role === 'tool');
    const done = toolMsgs[toolMsgs.length - 1];
    assert.equal(done.state, 'done');
    assert.equal(done.output.length, 20 * 1024);
    assert.equal(done.durationSeconds, 0.4);

    runner.clearIdleTimer();
  });

  test('tool ACTIVE + DONE en el mismo chunk de stdout preservan el orden de llegada', async () => {
    // Regresión: ACTIVE y DONE comparten `id` (mismo step_index). upsert() hace I/O
    // async (fs.appendFile); si se procesan como fire-and-forget en vez de en cola,
    // el DONE puede llegar a emitirse antes que el ACTIVE (visto en un E2E real).
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    runner.on('message', (m) => messages.push(m));

    await runner.send('ejecuta algo');
    const child = spawnImpl.calls[0].child;

    const active = {
      event: 'step_update',
      step_update: {
        conversation_id: 'c2b',
        step_index: 9,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo TOOL_OK' } },
      },
    };
    const done = {
      event: 'step_update',
      step_update: {
        conversation_id: 'c2b',
        step_index: 9,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo TOOL_OK' }, output: 'TOOL_OK\n' },
        duration_seconds: 0.1,
      },
    };
    // Ambas líneas en un único evento 'data' (un solo chunk), como puede llegar de un pipe real.
    child.stdout.emit('data', JSON.stringify(active) + '\n' + JSON.stringify(done) + '\n');
    await runner.flush();

    const toolMsgs = messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 2);
    assert.equal(toolMsgs[0].state, 'active');
    assert.equal(toolMsgs[1].state, 'done');

    runner.clearIdleTimer();
  });

  test('tool ERROR → mensaje con error', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    runner.on('message', (m) => messages.push(m));

    await runner.send('escribe un fichero');
    const child = spawnImpl.calls[0].child;
    sendLine(child, {
      event: 'step_update',
      step_update: {
        conversation_id: 'c3',
        step_index: 2,
        state: 'ERROR',
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: {
          name: 'write_to_file',
          parameters: { TargetFile: '/tmp/x.txt' },
          error: { type: 'permission', message: 'user denied permission' },
        },
      },
    });
    await runner.flush();
    const toolMsg = messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.state, 'error');
    assert.match(toolMsg.error, /user denied permission/);

    runner.clearIdleTimer();
  });

  test('stderr con "user denied permission" emite system kind error', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    runner.on('message', (m) => messages.push(m));

    await runner.send('haz algo sin permiso');
    const child = spawnImpl.calls[0].child;
    child.stderr.emit('data', 'WARN: user denied permission for run_command\n');
    await runner.flush();

    const sysMsg = messages.find((m) => m.role === 'system' && m.kind === 'error');
    assert.ok(sysMsg, 'debe emitir un mensaje system de error por denegación de permiso');
    assert.match(sysMsg.text, /auto-aprobad/i);

    runner.clearIdleTimer();
  });

  test('step_type unknown se ignora', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    runner.on('message', (m) => messages.push(m));

    await runner.send('pregunta');
    const child = spawnImpl.calls[0].child;
    sendLine(child, {
      event: 'step_update',
      step_update: { conversation_id: 'c4', step_index: 5, state: 'DONE', step_type: 'unknown' },
    });
    await runner.flush();
    assert.equal(messages.length, 1); // solo el mensaje de usuario inicial

    runner.clearIdleTimer();
  });

  test('dispose(): eventos tardíos del proceso ya matado no escriben en disco', async () => {
    // Regresión: al borrar un chat (DELETE), el proceso recién matado puede seguir
    // emitiendo NDJSON un instante (p.ej. un `result` de error final); sin dispose(),
    // ese evento tardío resucita el .ndjson/.json del chat ya borrado.
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    const chatEvents = [];
    runner.on('message', (m) => messages.push(m));
    runner.on('chat', (c) => chatEvents.push(c));

    await runner.send('hola');
    const child = spawnImpl.calls[0].child;
    await runner.flush();
    const chatEventsBeforeDispose = chatEvents.length;
    const messagesBeforeDispose = messages.length;

    await store.deleteChat(chat.id); // simula lo que hace DELETE /api/chats/:id
    runner.dispose();

    sendLine(child, {
      event: 'result',
      result: { conversation_id: 'c7', status: 'ERROR', error: 'stream input cancelled: context canceled' },
    });
    await runner.flush();

    // dispose() debe impedir CUALQUIER escritura/emit adicional tras el borrado, no solo la primera.
    assert.equal(chatEvents.length, chatEventsBeforeDispose);
    assert.equal(messages.length, messagesBeforeDispose);
    assert.deepEqual(await store.readMessages(chat.id), []); // el .ndjson no debe resucitar
    await assert.rejects(store.getChat(chat.id), (err) => {
      assert.equal(err.status, 404);
      return true;
    });

    runner.clearIdleTimer();
  });

  test('result con status ERROR emite system kind error y vuelve a idle', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    const states = [];
    runner.on('message', (m) => messages.push(m));
    runner.on('state', (s) => states.push(s));

    const p = runner.send('rompe algo');
    const child = spawnImpl.calls[0].child;
    sendLine(child, {
      event: 'result',
      result: { conversation_id: 'c5', status: 'ERROR', error: 'algo salió mal', duration_seconds: 0.1, num_turns: 1 },
    });
    await runner.flush();
    await p;

    assert.equal(runner.chat.state, 'idle');
    assert.ok(messages.some((m) => m.role === 'system' && m.kind === 'error' && m.text === 'algo salió mal'));

    runner.clearIdleTimer();
  });

  test('send() con turno en curso lanza HttpError 409', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    await runner.send('primer turno');
    await assert.rejects(runner.send('segundo turno'), (err) => {
      assert.equal(err.status, 409);
      return true;
    });
    runner.clearIdleTimer();
  });

  test('stop(): cierra assistant abierto con interrupted:true y system "Detenido"', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    runner.on('message', (m) => messages.push(m));

    await runner.send('cuento largo');
    const child = spawnImpl.calls[0].child;
    sendLine(child, {
      event: 'step_update',
      step_update: { conversation_id: 'c6', step_index: 0, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Había una vez' },
    });
    await runner.flush();

    await runner.stop();
    assert.equal(runner.chat.state, 'idle');
    assert.equal(child.killed, true);

    const assistant = messages.filter((m) => m.role === 'assistant').pop();
    assert.equal(assistant.interrupted, true);
    assert.equal(assistant.done, true);
    const sysMsg = messages.find((m) => m.role === 'system' && m.kind === 'stopped');
    assert.ok(sysMsg);
    assert.equal(sysMsg.text, 'Detenido');

    runner.clearIdleTimer();
  });

  test('salida inesperada del proceso durante un turno → system error + idle', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    const states = [];
    runner.on('message', (m) => messages.push(m));
    runner.on('state', (s) => states.push(s));

    const p = runner.send('algo').catch(() => {});
    const child = spawnImpl.calls[0].child;
    child.emit('exit', 1);
    await runner.flush();
    await p;

    assert.equal(runner.chat.state, 'idle');
    const sysMsg = messages.find((m) => m.role === 'system' && m.kind === 'error');
    assert.ok(sysMsg);
    assert.match(sysMsg.text, /Antigravity terminó \(código 1\)/);

    runner.clearIdleTimer();
  });

  test('reanuda con --conversation cuando el chat ya tiene conversationId', async () => {
    const chat = baseChat({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    await runner.send('sigue la conversación');
    assert.deepEqual(spawnImpl.calls[0].args.slice(-2), ['--conversation', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
    runner.clearIdleTimer();
  });
});

// ---------------------------------------------------------------------------
// runner.js: fix de workspace (--add-dir) y system 'info' de arranque
// ---------------------------------------------------------------------------

describe('ChatRunner: adjuntos (uploads)', () => {
  test('buildArgv() añade --add-dir con la carpeta de adjuntos del chat', () => {
    const chat = baseChat();
    const runner = new ChatRunner(chat, { spawnImpl: makeSpawnImpl(), resolveModel: identityModel });
    const argv = runner.buildArgv();
    const dirs = argv.map((a, i) => (argv[i - 1] === '--add-dir' ? a : null)).filter(Boolean);
    assert.deepEqual(dirs, [chat.cwd, store.uploadsDir(chat.id)]);
  });

  test('composePrompt: sin adjuntos devuelve el texto; con adjuntos añade las rutas absolutas', () => {
    assert.equal(composePrompt('hola', []), 'hola');
    const p = composePrompt('¿qué color es?', [{ path: '/x/uploads/c_1/red.png' }]);
    assert.ok(p.startsWith('¿qué color es?\n\n['));
    assert.ok(p.includes('view_file'));
    assert.ok(p.endsWith('- /x/uploads/c_1/red.png'));
    const only = composePrompt('', [{ path: '/x/a.pdf' }, { path: '/x/b.pdf' }]);
    assert.ok(only.startsWith('['));
    assert.ok(only.includes('- /x/a.pdf\n- /x/b.pdf'));
  });

  test('resolveAttachments: valida nombres y existencia; devuelve name/url/type/size', async () => {
    const chat = baseChat();
    const dir = store.uploadsDir(chat.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'foto 1.jpg'), Buffer.from([1, 2, 3]));
    const files = await resolveAttachments(chat.id, ['foto 1.jpg']);
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'foto 1.jpg');
    assert.equal(files[0].path, path.join(dir, 'foto 1.jpg'));
    assert.equal(files[0].url, `/api/chats/${chat.id}/uploads/foto%201.jpg`);
    assert.equal(files[0].type, 'image/jpeg');
    assert.equal(files[0].size, 3);
    assert.deepEqual(await resolveAttachments(chat.id, undefined), []);
    await assert.rejects(resolveAttachments(chat.id, ['../sessions.json']), (e) => e.status === 400);
    await assert.rejects(resolveAttachments(chat.id, ['no-existe.png']), (e) => e.status === 400);
    await assert.rejects(resolveAttachments(chat.id, 'foto 1.jpg'), (e) => e.status === 400);
  });

  test('send(text, attachments): mensaje de usuario con attachments y prompt con rutas; spawn crea la carpeta', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const dir = store.uploadsDir(chat.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'red.png'), Buffer.from([0x89, 0x50]));
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const msg = await runner.send('', ['red.png']);
    assert.equal(msg.text, '');
    assert.deepEqual(msg.attachments, [{ name: 'red.png', url: `/api/chats/${chat.id}/uploads/red.png`, type: 'image/png', size: 2 }]);
    const written = JSON.parse(spawnImpl.calls[0].child.stdin.written[0]);
    assert.ok(written.message.content.includes(path.join(dir, 'red.png')));
    const saved = await store.getChat(chat.id);
    assert.equal(saved.title, 'red.png');
    const stored = await store.readMessages(chat.id);
    assert.deepEqual(stored[0].attachments, msg.attachments);
    runner.clearIdleTimer();
  });

  test('send() sin texto ni adjuntos → 400; adjunto inexistente → 400 sin arrancar el proceso', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    await assert.rejects(runner.send('', []), (e) => e.status === 400);
    await assert.rejects(runner.send('hola', ['fantasma.png']), (e) => e.status === 400);
    assert.equal(spawnImpl.calls.length, 0);
    assert.equal(runner.chat.state, 'idle');
  });

  test('spawn() crea la carpeta de adjuntos y deleteChat la borra', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const runner = new ChatRunner(chat, { spawnImpl: makeSpawnImpl(), resolveModel: identityModel });
    await runner.send('hola');
    const dir = store.uploadsDir(chat.id);
    assert.ok((await fs.stat(dir)).isDirectory());
    runner.clearIdleTimer();
    await store.deleteChat(chat.id);
    await assert.rejects(fs.stat(dir));
  });
});

describe('ChatRunner: --add-dir y system info de arranque', () => {
  test('buildArgv() nunca combina --model con --effort (agy lo rechaza); sin modelo pasa --effort', () => {
    const withModel = new ChatRunner({ ...baseChat(), model: 'gemini-3.7-flash-medium', effort: 'high' }, { spawnImpl: makeSpawnImpl(), resolveModel: identityModel });
    const a = withModel.buildArgv('gemini-3.7-flash-high');
    assert.deepEqual(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2), ['--model', 'gemini-3.7-flash-high']);
    assert.equal(a.includes('--effort'), false);
    const noModel = new ChatRunner({ ...baseChat(), model: null, effort: 'low' }, { spawnImpl: makeSpawnImpl(), resolveModel: identityModel });
    const b = noModel.buildArgv(null);
    assert.equal(b.includes('--model'), false);
    assert.deepEqual(b.slice(b.indexOf('--effort'), b.indexOf('--effort') + 2), ['--effort', 'low']);
    withModel.clearIdleTimer();
    noModel.clearIdleTimer();
  });

  test('buildArgv() incluye --add-dir con el cwd del chat', () => {
    const chat = baseChat();
    const runner = new ChatRunner(chat, { spawnImpl: makeSpawnImpl(), resolveModel: identityModel });
    const argv = runner.buildArgv();
    const i = argv.indexOf('--add-dir');
    assert.ok(i >= 0, 'buildArgv() debe incluir --add-dir');
    assert.equal(argv[i + 1], chat.cwd);
  });

  test('handleInit emite system kind info con cwd/auto-aprobar/modelo/esfuerzo/modo', async () => {
    const chat = baseChat({ model: 'gemini-3-pro', effort: 'high', mode: 'plan' });
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    runner.on('message', (m) => messages.push(m));

    await runner.send('hola');
    const child = spawnImpl.calls[0].child;
    sendLine(child, {
      event: 'init',
      conversation_id: '22222222-2222-4222-8222-222222222222',
      init: { cwd: chat.cwd, tools: [], permission_mode: 'request-review' },
    });
    await runner.flush();

    const info = messages.find((m) => m.role === 'system' && m.kind === 'info');
    assert.ok(info, 'debe emitir un system kind info al init');
    assert.match(info.id, /^sys-init-/);
    assert.equal(info.text, `Antigravity en ${chat.cwd} · auto-aprobar ON · gemini-3-pro · high · modo plan`);

    runner.clearIdleTimer();
  });

  test('handleInit dice "reanudado" cuando el chat ya tenía conversationId antes del spawn', async () => {
    const chat = baseChat({
      conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      mode: 'accept-edits',
      autoApprove: false,
    });
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    runner.on('message', (m) => messages.push(m));

    await runner.send('continúa');
    const child = spawnImpl.calls[0].child;
    sendLine(child, {
      event: 'init',
      conversation_id: chat.conversationId,
      init: { cwd: chat.cwd, tools: [], permission_mode: 'request-review' },
    });
    await runner.flush();

    const info = messages.find((m) => m.role === 'system' && m.kind === 'info');
    assert.ok(info);
    assert.equal(
      info.text,
      `Antigravity reanudado en ${chat.cwd} · auto-aprobar OFF · modelo por defecto · por defecto · modo aceptar ediciones`
    );

    runner.clearIdleTimer();
  });
});

// ---------------------------------------------------------------------------
// runner.js + transcript.js: thinking leído del transcript de agy (attachThinking)
// ---------------------------------------------------------------------------

describe('ChatRunner: thinking desde el transcript (attachThinking)', () => {
  let cliHome;
  let prevCliHome;

  before(async () => {
    prevCliHome = process.env.AGY_CLI_HOME;
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-rc-cli-home-'));
    process.env.AGY_CLI_HOME = cliHome; // ejercita el override de transcript.baseDir(), no solo $HOME
  });

  after(async () => {
    if (prevCliHome === undefined) delete process.env.AGY_CLI_HOME;
    else process.env.AGY_CLI_HOME = prevCliHome;
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  async function writeTranscript(conversationId, steps) {
    const dir = path.join(cliHome, 'brain', conversationId, '.system_generated', 'logs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'transcript.jsonl'), steps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  }

  test('con delta: el thinking se adjunta al mensaje assistant ya persistido (sin pisar el texto)', async () => {
    const conversationId = 'think-aaaaaaaa';
    await writeTranscript(conversationId, [
      { step_index: 5, type: 'PLANNER_RESPONSE', content: 'Hola', thinking: '  Razonando sobre la respuesta  ' },
    ]);

    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    runner.on('message', (m) => messages.push(m));

    await runner.send('hola');
    const child = spawnImpl.calls[0].child;
    sendLine(child, {
      event: 'step_update',
      step_update: {
        conversation_id: conversationId,
        step_index: 5,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: 'Hola',
      },
    });
    sendLine(child, {
      event: 'step_update',
      step_update: { conversation_id: conversationId, step_index: 5, state: 'DONE', step_type: 'agent_response' },
    });
    await runner.flush();

    const assistantMsgs = messages.filter((m) => m.role === 'assistant');
    const last = assistantMsgs[assistantMsgs.length - 1];
    assert.equal(last.text, 'Hola');
    assert.equal(last.done, true);
    assert.equal(last.thinking, 'Razonando sobre la respuesta');

    runner.clearIdleTimer();
  });

  test('sin delta pero con thinking: crea el paso "solo pensó" (text vacío, done, thinking)', async () => {
    const conversationId = 'think-bbbbbbbb';
    await writeTranscript(conversationId, [
      { step_index: 0, type: 'PLANNER_RESPONSE', content: '', thinking: 'Solo pensó, sin texto visible' },
    ]);

    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    runner.on('message', (m) => messages.push(m));

    await runner.send('hola');
    const child = spawnImpl.calls[0].child;
    sendLine(child, {
      event: 'step_update',
      step_update: { conversation_id: conversationId, step_index: 0, state: 'ACTIVE', step_type: 'agent_response' },
    });
    sendLine(child, {
      event: 'step_update',
      step_update: { conversation_id: conversationId, step_index: 0, state: 'DONE', step_type: 'agent_response' },
    });
    await runner.flush();

    const assistantMsgs = messages.filter((m) => m.role === 'assistant');
    assert.equal(assistantMsgs.length, 1);
    assert.equal(assistantMsgs[0].text, '');
    assert.equal(assistantMsgs[0].done, true);
    assert.equal(assistantMsgs[0].thinking, 'Solo pensó, sin texto visible');

    runner.clearIdleTimer();
  });

  test('sin transcript para esa conversación: no rompe nada y no crea burbuja', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const messages = [];
    runner.on('message', (m) => messages.push(m));

    await runner.send('hola');
    const child = spawnImpl.calls[0].child;
    sendLine(child, {
      event: 'step_update',
      step_update: { conversation_id: 'think-sin-transcript', step_index: 0, state: 'DONE', step_type: 'agent_response' },
    });
    await runner.flush();

    assert.equal(messages.filter((m) => m.role === 'assistant').length, 0);

    runner.clearIdleTimer();
  });
});

// ---------------------------------------------------------------------------
// runner.js + store.js: registro crudo del CLI (rawLog / readLogTail)
// ---------------------------------------------------------------------------

describe('ChatRunner + store: registro crudo (rawLog)', () => {
  test('spawn registra cmd y sys, stdout registra out, stop registra sys "kill (detener)"', async () => {
    const chat = baseChat();
    await store.saveChat(chat);
    const spawnImpl = makeSpawnImpl();
    const runner = new ChatRunner(chat, { spawnImpl, resolveModel: identityModel });
    const rawEntries = [];
    runner.on('raw', (e) => rawEntries.push(e));

    await runner.send('hola');
    const child = spawnImpl.calls[0].child;
    sendLine(child, { event: 'init', conversation_id: 'rawc1', init: { cwd: chat.cwd } });
    await runner.flush();

    assert.ok(
      rawEntries.some((e) => e.src === 'cmd' && e.line.includes('--add-dir') && e.line.endsWith(`# cwd=${chat.cwd}`)),
      'debe registrar el argv de arranque (cmd)'
    );
    assert.ok(
      rawEntries.some((e) => e.src === 'sys' && /^spawn pid=/.test(e.line)),
      'debe registrar el spawn (sys)'
    );
    assert.ok(
      rawEntries.some((e) => e.src === 'out' && e.line.includes('"event":"init"')),
      'debe registrar la línea stdout NDJSON (out)'
    );

    await runner.stop();
    await runner.flush();
    assert.ok(rawEntries.some((e) => e.src === 'sys' && e.line === 'kill (detener)'));

    const persisted = await store.readLogTail(chat.id, 500);
    assert.ok(persisted.some((e) => e.src === 'cmd'));
    assert.ok(persisted.some((e) => e.src === 'out'));

    runner.clearIdleTimer();
  });

  test('readLogTail devuelve las últimas N; trimLogIfNeeded recorta por encima de 4000 líneas', async () => {
    const chat = await store.createChat({ cwd: projectsRoot });
    await store.appendLog(chat.id, { ts: 1, src: 'out', line: 'a' });
    await store.appendLog(chat.id, { ts: 2, src: 'out', line: 'b' });
    await store.appendLog(chat.id, { ts: 3, src: 'out', line: 'c' });
    const last2 = await store.readLogTail(chat.id, 2);
    assert.deepEqual(
      last2.map((e) => e.line),
      ['b', 'c']
    );

    // Simula un log grande escribiendo el fichero directamente (más rápido que 4000+ appends).
    const logFile = path.join(dataDir, 'chats', `${chat.id}.log`);
    const bulkLines = [];
    for (let i = 0; i < 4200; i++) {
      bulkLines.push(JSON.stringify({ ts: i, src: 'out', line: `bulk-${i}` }));
    }
    await fs.writeFile(logFile, bulkLines.join('\n') + '\n', 'utf8');

    await store.trimLogIfNeeded(chat.id);
    const tail = await store.readLogTail(chat.id, 100000);
    assert.ok(tail.length <= 2000);
    assert.equal(tail[tail.length - 1].line, 'bulk-4199');
  });

  test('readLogTail de chat sin log → []', async () => {
    const chat = await store.createChat({ cwd: projectsRoot });
    assert.deepEqual(await store.readLogTail(chat.id), []);
  });
});

// ---------------------------------------------------------------------------
// store.js: upsert / reconstrucción
// ---------------------------------------------------------------------------

describe('store', () => {
  test('appendMessage + readMessages: el último gana por id, conserva orden de primera aparición', async () => {
    const chat = await store.createChat({ cwd: projectsRoot });
    await store.appendMessage(chat.id, { id: 'u-1', ts: 1, role: 'user', text: 'hola' });
    await store.appendMessage(chat.id, { id: 'a-1', ts: 2, role: 'assistant', text: 'h', done: false });
    await store.appendMessage(chat.id, { id: 'a-1', ts: 3, role: 'assistant', text: 'hola!', done: true });
    await store.appendMessage(chat.id, { id: 'u-2', ts: 4, role: 'user', text: 'gracias' });

    const messages = await store.readMessages(chat.id);
    assert.equal(messages.length, 3);
    assert.deepEqual(
      messages.map((m) => m.id),
      ['u-1', 'a-1', 'u-2']
    );
    assert.equal(messages[1].text, 'hola!');
    assert.equal(messages[1].done, true);
  });

  test('readMessages con limit devuelve los últimos N', async () => {
    const chat = await store.createChat({ cwd: projectsRoot });
    for (let i = 0; i < 5; i++) {
      await store.appendMessage(chat.id, { id: `m-${i}`, ts: i, role: 'user', text: String(i) });
    }
    const last2 = await store.readMessages(chat.id, 2);
    assert.deepEqual(
      last2.map((m) => m.id),
      ['m-3', 'm-4']
    );
  });

  test('readMessages de un chat sin mensajes → []', async () => {
    const chat = await store.createChat({ cwd: projectsRoot });
    assert.deepEqual(await store.readMessages(chat.id), []);
  });

  test('createChat/getChat/listChats/deleteChat', async () => {
    const chat = await store.createChat({ cwd: projectsRoot, title: 'Mi chat' });
    assert.match(chat.id, /^c_[0-9a-f]{10}$/);
    assert.equal(chat.state, 'idle');
    assert.equal(chat.autoApprove, true);

    const fetched = await store.getChat(chat.id);
    assert.equal(fetched.title, 'Mi chat');

    const all = await store.listChats();
    assert.ok(all.some((c) => c.id === chat.id));

    await store.deleteChat(chat.id);
    await assert.rejects(store.getChat(chat.id), (err) => {
      assert.equal(err.status, 404);
      return true;
    });
  });

  test('defaultTitle: primeros 60 caracteres', () => {
    const long = 'x'.repeat(100);
    assert.equal(store.defaultTitle(long).length, 60);
    assert.equal(store.defaultTitle('  hola  '), 'hola');
  });
});

// ---------------------------------------------------------------------------
// transcript.js: importTranscript / listConversations
// ---------------------------------------------------------------------------

describe('transcript', () => {
  const conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  before(async () => {
    const brainDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'brain', conversationId, '.system_generated', 'logs');
    await fs.mkdir(brainDir, { recursive: true });

    const steps = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-08-30T10:00:00.000Z',
        content:
          '<USER_REQUEST>\nRecuerda la palabra clave MANZANA\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nignorar esto\n</ADDITIONAL_METADATA>',
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-08-30T10:00:05.000Z',
        content: 'Entendido, recordaré MANZANA.',
        thinking: 'Pensé un poco antes de responder.',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo TOOL_OK' } }],
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-08-30T10:00:06.000Z',
        content: 'TOOL_OK\n',
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-08-30T10:00:07.000Z',
        content: 'salida huérfana, sin tool pendiente: se ignora',
      },
    ];
    const lines = steps.map((s) => JSON.stringify(s)).join('\n') + '\n';
    await fs.writeFile(path.join(brainDir, 'transcript.jsonl'), lines, 'utf8');

    const historyFile = path.join(homeDir, '.gemini', 'antigravity-cli', 'history.jsonl');
    const historyLines = [
      { display: 'Recuerda la palabra clave MANZANA', timestamp: '2026-08-30T10:00:00.000Z', workspace: '/home/x/agy-rc', conversationId },
      { display: 'exit', timestamp: '2026-08-30T10:05:00.000Z', workspace: '/home/x/agy-rc', conversationId },
      { display: 'otra sesión sin conversationId', timestamp: '2026-08-30T09:00:00.000Z', workspace: '/home/x/otro' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n';
    await fs.writeFile(historyFile, historyLines, 'utf8');
  });

  test('extractUserRequest descarta ADDITIONAL_METADATA', () => {
    const raw = '<USER_REQUEST>\nHola\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>';
    assert.equal(transcript.extractUserRequest(raw), 'Hola');
  });

  test('importTranscript: USER_INPUT, PLANNER_RESPONSE con tool_calls, GENERIC como output', async () => {
    const messages = await transcript.importTranscript(conversationId);
    assert.equal(messages.length, 3); // user, assistant, tool (el GENERIC huérfano no genera mensaje)

    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].text, 'Recuerda la palabra clave MANZANA');

    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].text, 'Entendido, recordaré MANZANA.');
    assert.equal(messages[1].done, true);
    assert.equal(messages[1].thinking, 'Pensé un poco antes de responder.');

    assert.equal(messages[2].role, 'tool');
    assert.equal(messages[2].name, 'run_command');
    assert.equal(messages[2].summary, 'echo TOOL_OK');
    assert.equal(messages[2].output, 'TOOL_OK\n');
  });

  test('importTranscript de conversationId inexistente → []', async () => {
    assert.deepEqual(await transcript.importTranscript('00000000-0000-4000-8000-000000000000'), []);
  });

  test('readStepThinking: devuelve el thinking (trim) del PLANNER_RESPONSE con ese step_index', async () => {
    assert.equal(await transcript.readStepThinking(conversationId, 1), 'Pensé un poco antes de responder.');
  });

  test('readStepThinking: step_index inexistente → null', async () => {
    assert.equal(await transcript.readStepThinking(conversationId, 999), null);
  });

  test('readStepThinking: conversationId sin transcript → null', async () => {
    assert.equal(await transcript.readStepThinking('00000000-0000-4000-8000-000000000000', 0), null);
  });

  test('baseDir() respeta AGY_CLI_HOME (override) por encima de $HOME', () => {
    const prev = process.env.AGY_CLI_HOME;
    process.env.AGY_CLI_HOME = '/tmp/algun-agy-cli-home';
    try {
      assert.equal(transcript.baseDir(), '/tmp/algun-agy-cli-home');
    } finally {
      if (prev === undefined) delete process.env.AGY_CLI_HOME;
      else process.env.AGY_CLI_HOME = prev;
    }
  });

  test('listConversations: dedupe por conversationId, título = último display no vacío ni "exit"', async () => {
    const conversations = await transcript.listConversations(50);
    const entry = conversations.find((c) => c.conversationId === conversationId);
    assert.ok(entry);
    assert.equal(entry.title, 'Recuerda la palabra clave MANZANA');
    assert.equal(entry.source, 'history');
    assert.equal(entry.workspace, '/home/x/agy-rc');
  });

  test('listConversations respeta el limit', async () => {
    const conversations = await transcript.listConversations(1);
    assert.equal(conversations.length, 1);
  });
});

// ---------------------------------------------------------------------------
// routes.js: validaciones REST (sin llamar a agy real)
// ---------------------------------------------------------------------------

describe('rutas /api/chats: validaciones', () => {
  let server;
  let baseUrl;
  // execFile falso para POST /chats/:id/command (agy --print=/cmd): registra llamadas y devuelve TSV
  const execCalls = [];
  const fakeExec = async (cmd, args, opts) => {
    execCalls.push({ cmd, args, opts });
    if (args[0] === '--print=/agents') throw new Error('agy explotó');
    return { stdout: 'Gemini Models\tWeekly Limit Remaining\t99%\t2026-09-08T15:56:46Z\n', stderr: '' };
  };

  before(async () => {
    const app = createApp({ chatRouterDeps: { execImpl: fakeExec } });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function req(method, urlPath, body) {
    const res = await fetch(baseUrl + urlPath, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // sin cuerpo (204)
    }
    return { status: res.status, body: json };
  }

  test('POST /api/chats sin cwd → 400', async () => {
    const { status, body } = await req('POST', '/api/chats', {});
    assert.equal(status, 400);
    assert.match(body.error, /cwd/);
  });

  test('POST /api/chats con cwd fuera de projectsRoot → 400', async () => {
    const { status } = await req('POST', '/api/chats', { cwd: '../../etc' });
    assert.equal(status, 400);
  });

  test('POST /api/chats con model inválido → 400', async () => {
    const { status } = await req('POST', '/api/chats', { cwd: 'proyecto-a', model: 'no valido!' });
    assert.equal(status, 400);
  });

  test('POST /api/chats con effort inválido → 400', async () => {
    const { status } = await req('POST', '/api/chats', { cwd: 'proyecto-a', effort: 'muy-alto' });
    assert.equal(status, 400);
  });

  test('POST /api/chats con mode inválido → 400', async () => {
    const { status } = await req('POST', '/api/chats', { cwd: 'proyecto-a', mode: 'turbo' });
    assert.equal(status, 400);
  });

  test('POST /api/chats con conversationId no-uuid-v4 → 400', async () => {
    const { status } = await req('POST', '/api/chats', { cwd: 'proyecto-a', conversationId: 'no-es-un-uuid' });
    assert.equal(status, 400);
  });

  test('POST /api/chats válido → 201 con defaults', async () => {
    const { status, body } = await req('POST', '/api/chats', { cwd: 'proyecto-a' });
    assert.equal(status, 201);
    assert.match(body.id, /^c_[0-9a-f]{10}$/);
    assert.equal(body.mode, 'normal');
    assert.equal(body.autoApprove, true);
    assert.equal(body.state, 'idle');
  });

  test('GET /api/chats/:id con id inválido → 400', async () => {
    const { status } = await req('GET', '/api/chats/not-a-valid-id');
    assert.equal(status, 400);
  });

  test('GET /api/chats/:id inexistente (formato válido) → 404', async () => {
    const { status } = await req('GET', '/api/chats/c_0000000000');
    assert.equal(status, 404);
  });

  test('GET /api/chats/:id devuelve {chat, messages}', async () => {
    const created = await req('POST', '/api/chats', { cwd: 'proyecto-a', title: 'Test' });
    const { status, body } = await req('GET', `/api/chats/${created.body.id}`);
    assert.equal(status, 200);
    assert.equal(body.chat.id, created.body.id);
    assert.deepEqual(body.messages, []);
  });

  test('GET /api/chats lista con lastMessage', async () => {
    const { status, body } = await req('GET', '/api/chats');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });

  test('POST /api/chats/:id/send con text vacío → 400', async () => {
    const created = await req('POST', '/api/chats', { cwd: 'proyecto-a' });
    const { status } = await req('POST', `/api/chats/${created.body.id}/send`, { text: '' });
    assert.equal(status, 400);
  });

  test('POST /api/chats/:id/command ejecuta agy --print=/cmd en el cwd del chat y añade un system kind cli', async () => {
    const created = await req('POST', '/api/chats', { cwd: 'proyecto-a' });
    const id = created.body.id;
    const { status, body } = await req('POST', `/api/chats/${id}/command`, { cmd: '/usage' });
    assert.equal(status, 200);
    assert.equal(body.kind, 'cli');
    const call = execCalls.find((c) => c.args[0] === '--print=/usage');
    assert.ok(call, 'debe invocar agy --print=/usage');
    assert.equal(call.opts.cwd, path.join(projectsRoot, 'proyecto-a'));
    const { body: full } = await req('GET', `/api/chats/${id}`);
    const msg = full.messages.find((m) => m.id === body.messageId);
    assert.equal(msg.role, 'system');
    assert.equal(msg.kind, 'cli');
    assert.equal(msg.cmd, '/usage');
    assert.equal(msg.text, 'Gemini Models · Weekly Limit Remaining · 99% · 2026-09-08T15:56:46Z');
  });

  test('POST /api/chats/:id/command: fallo de agy → system kind error; cmd no permitido → 400; chat inexistente → 404', async () => {
    const created = await req('POST', '/api/chats', { cwd: 'proyecto-a' });
    const id = created.body.id;
    const failed = await req('POST', `/api/chats/${id}/command`, { cmd: '/agents' });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.kind, 'error');
    const { body: full } = await req('GET', `/api/chats/${id}`);
    assert.match(full.messages.find((m) => m.id === failed.body.messageId).text, /agy explotó/);

    for (const cmd of ['/plan', '/context', 'usage', '', '/usage; rm -rf /']) {
      const bad = await req('POST', `/api/chats/${id}/command`, { cmd });
      assert.equal(bad.status, 400, `cmd ${JSON.stringify(cmd)} debe dar 400`);
    }
    const missing = await req('POST', '/api/chats/c_0000000000/command', { cmd: '/usage' });
    assert.equal(missing.status, 404);
  });

  test('sanitizeUploadName: quita rutas, acentos y caracteres raros; conserva extensión', () => {
    assert.equal(sanitizeUploadName('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeUploadName('Foto ñandú (1).JPG'), 'Foto nandu _1_.jpg');
    assert.equal(sanitizeUploadName('...'), 'archivo');
    assert.equal(sanitizeUploadName(undefined), 'archivo');
    assert.equal(sanitizeUploadName('C:\\Users\\x\\doc.pdf'), 'doc.pdf');
    assert.equal(sanitizeUploadName('a'.repeat(300) + '.txt').length <= 121, true);
  });

  test('PUT /api/chats/:id/uploads guarda el archivo (dedupe -1), GET lo sirve, send lo acepta con text vacío', async () => {
    const created = await req('POST', '/api/chats', { cwd: 'proyecto-a' });
    const id = created.body.id;
    const bytes = Buffer.from('hola adjunto');
    const put = async () =>
      fetch(`${baseUrl}/api/chats/${id}/uploads?name=${encodeURIComponent('nota final.txt')}`, {
        method: 'PUT',
        headers: { 'content-type': 'text/plain' },
        body: bytes,
      });
    const r1 = await put();
    assert.equal(r1.status, 201);
    const j1 = await r1.json();
    assert.equal(j1.name, 'nota final.txt');
    assert.equal(j1.size, bytes.length);
    assert.equal(j1.type, 'text/plain');
    assert.equal(j1.url, `/api/chats/${id}/uploads/nota%20final.txt`);
    const r2 = await put();
    const j2 = await r2.json();
    assert.equal(j2.name, 'nota final-1.txt');

    const got = await fetch(baseUrl + j1.url);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), 'hola adjunto');
    const missing = await fetch(`${baseUrl}/api/chats/${id}/uploads/no.txt`);
    assert.equal(missing.status, 404);
    assert.equal(got.headers.get('content-security-policy'), "default-src 'none'; sandbox");

    // contenido activo (html/svg) nunca se sirve inline desde el origen de la app
    const evil = await fetch(`${baseUrl}/api/chats/${id}/uploads?name=evil.svg`, {
      method: 'PUT',
      headers: { 'content-type': 'image/svg+xml' },
      body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    });
    assert.equal(evil.status, 201);
    const served = await fetch(`${baseUrl}/api/chats/${id}/uploads/evil.svg`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'application/octet-stream');
    assert.match(served.headers.get('content-disposition'), /^attachment/);

    // .json subido no debe pasar por express.json (cuerpo crudo, y sin límite de 256 kb)
    const big = Buffer.alloc(300 * 1024, 0x7b);
    const r3 = await fetch(`${baseUrl}/api/chats/${id}/uploads?name=datos.json`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: big,
    });
    assert.equal(r3.status, 201);
    assert.equal((await r3.json()).size, big.length);

    // send con text vacío + attachments válidos pasa la validación (falla luego al lanzar agy o no,
    // según el entorno; aquí solo comprobamos que no es 400 por el texto)
    const bad = await req('POST', `/api/chats/${id}/send`, { text: '', attachments: ['fantasma.txt'] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error || JSON.stringify(bad.body), /fantasma/);

    const empty = await fetch(`${baseUrl}/api/chats/${id}/uploads?name=x.bin`, { method: 'PUT', body: '' });
    assert.equal(empty.status, 400);
    const nochat = await fetch(`${baseUrl}/api/chats/c_0000000000/uploads?name=x.bin`, { method: 'PUT', body: bytes });
    assert.equal(nochat.status, 404);

    const del = await req('DELETE', `/api/chats/${id}`);
    assert.equal(del.status, 204);
    await assert.rejects(fs.stat(store.uploadsDir(id)));
  });

  test('PATCH /api/chats/:id actualiza título', async () => {
    const created = await req('POST', '/api/chats', { cwd: 'proyecto-a' });
    const { status, body } = await req('PATCH', `/api/chats/${created.body.id}`, { title: 'Nuevo título' });
    assert.equal(status, 200);
    assert.equal(body.title, 'Nuevo título');
  });

  test('DELETE /api/chats/:id → 204 y luego 404', async () => {
    const created = await req('POST', '/api/chats', { cwd: 'proyecto-a' });
    const del = await req('DELETE', `/api/chats/${created.body.id}`);
    assert.equal(del.status, 204);
    const after2 = await req('GET', `/api/chats/${created.body.id}`);
    assert.equal(after2.status, 404);
  });

  test('GET /api/agy/conversations responde 200 con array', async () => {
    const { status, body } = await req('GET', '/api/agy/conversations');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });

  test('GET /api/chats/:id/log responde {entries:[]} para un chat recién creado', async () => {
    const created = await req('POST', '/api/chats', { cwd: 'proyecto-a' });
    const { status, body } = await req('GET', `/api/chats/${created.body.id}/log`);
    assert.equal(status, 200);
    assert.deepEqual(body.entries, []);
  });

  test('GET /api/chats/:id/log de chat inexistente (formato válido) → 404', async () => {
    const { status } = await req('GET', '/api/chats/c_0000000000/log');
    assert.equal(status, 404);
  });
});

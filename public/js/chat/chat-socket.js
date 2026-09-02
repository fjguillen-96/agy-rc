// public/js/chat/chat-socket.js
// WS /ws/chat?chat=<id> sobre ReconnectingSocket (§2.3 CHAT.md). Cola de envío en cliente
// mientras el turno está en curso (state !== 'idle'): se vacía al volver a 'idle'.
//
// Modo de prueba (sin backend): server/chat/routes.js todavía no existe cuando este módulo
// se escribió. Para poder validar la UI sin él, `connectChat(chatId, handlers, {simulate:true})`
// (o `?chatTestSim=1` en la URL) evita abrir un WebSocket real y en su lugar inyecta un
// `hello` falso y responde a `send`/`stop` con eventos simulados locales, para poder ver el
// render de burbujas/tarjetas/markdown de principio a fin. Quitar `simulate` en cuanto el
// backend esté disponible (no hace falta borrar el código: se activa solo con el flag).

import { ReconnectingSocket } from '../socket.js';
import { chatWsUrl } from '../api.js';

function isSimulateRequested() {
  try {
    return new URLSearchParams(location.search).get('chatTestSim') === '1';
  } catch {
    return false;
  }
}

/**
 * @param {string} chatId
 * @param {{onHello?, onMsg?, onState?, onChat?, onError?, onGone?, onUnauthorized?, onStatus?}} handlers
 * @param {{simulate?: boolean}} [opts]
 */
export function connectChat(chatId, handlers, opts = {}) {
  const simulate = opts.simulate ?? isSimulateRequested();
  let state = 'idle';
  const queue = [];
  const rawListeners = new Set(); // suscriptores de {t:'raw'} (sheet "Registro de agy")

  if (simulate) {
    return connectChatSimulated(chatId, handlers);
  }

  const socket = new ReconnectingSocket(() => chatWsUrl(chatId));

  socket.addEventListener('status', (ev) => handlers.onStatus && handlers.onStatus(ev.detail));

  socket.addEventListener('control', (ev) => {
    const msg = ev.detail;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello':
        state = msg.state;
        handlers.onHello && handlers.onHello(msg);
        flushQueue();
        // La suscripción al registro crudo es por conexión: tras reconectar hay que renovarla.
        if (rawListeners.size > 0) socket.send(JSON.stringify({ t: 'raw-sub' }));
        break;
      case 'msg':
        handlers.onMsg && handlers.onMsg(msg.message);
        break;
      case 'state':
        state = msg.state;
        handlers.onState && handlers.onState(msg.state);
        if (state === 'idle') flushQueue();
        break;
      case 'chat':
        handlers.onChat && handlers.onChat(msg.chat);
        break;
      case 'error':
        handlers.onError && handlers.onError(msg.message);
        break;
      case 'raw':
        for (const cb of rawListeners) cb(msg.entries);
        break;
      default:
        break;
    }
  });

  socket.addEventListener('gone', () => handlers.onGone && handlers.onGone());
  socket.addEventListener('unauthorized', () => handlers.onUnauthorized && handlers.onUnauthorized());

  function buildSendPayload(text, attachments) {
    const payload = { t: 'send', text };
    if (Array.isArray(attachments) && attachments.length > 0) payload.attachments = attachments;
    return payload;
  }

  function flushQueue() {
    if (state !== 'idle' || queue.length === 0 || !socket.isOpen()) return;
    const item = queue.shift();
    const ok = socket.send(JSON.stringify(buildSendPayload(item.text, item.attachments)));
    if (ok !== false) {
      state = 'starting';
    } else {
      queue.unshift(item);
    }
  }

  /**
   * @param {string} text
   * @param {string[]} [attachments] nombres devueltos por PUT /api/chats/:id/uploads
   */
  function send(text, attachments) {
    if (state === 'idle' && socket.isOpen()) {
      const ok = socket.send(JSON.stringify(buildSendPayload(text, attachments)));
      if (ok !== false) {
        state = 'starting';
        return { queued: false };
      }
    }
    queue.push({ text, attachments });
    // reason: 'offline' → sin conexión WS (se enviará al reconectar);
    //         'busy'    → agy está en mitad de un turno (se enviará al quedar idle).
    return { queued: true, position: queue.length, reason: socket.isOpen() ? 'busy' : 'offline' };
  }

  function stop() {
    socket.send(JSON.stringify({ t: 'stop' }));
  }

  /** Envía un mensaje de control crudo (p.ej. {t:'raw-sub'}/{t:'raw-unsub'}). */
  function sendRaw(obj) {
    socket.send(JSON.stringify(obj));
  }

  /**
   * Suscribe a un evento del socket no cubierto por los `handlers` fijos del connectChat
   * (de momento solo 'raw', usado por el sheet "Registro de agy").
   * @param {'raw'} event
   * @param {(entries: any[]) => void} cb
   * @returns {() => void} función para des-suscribir
   */
  function on(event, cb) {
    if (event !== 'raw') return () => {};
    rawListeners.add(cb);
    return () => rawListeners.delete(cb);
  }

  socket.connect();

  return {
    send,
    stop,
    sendRaw,
    on,
    destroy: () => socket.destroy(),
    getQueueLength: () => queue.length,
    isSimulated: false,
  };
}

// ---------- modo de prueba (sin servidor) ----------

function connectChatSimulated(chatId, handlers) {
  let seq = 0;
  const nextId = (prefix) => `${prefix}-sim-${chatId}-${seq++}`;

  setTimeout(() => {
    handlers.onHello && handlers.onHello({ t: 'hello', chat: chatId, state: 'idle', messages: [] });
  }, 30);

  function send(text, attachments) {
    const userMsg = { id: nextId('u'), ts: Date.now(), role: 'user', text };
    // Modo de prueba sin backend: no hay subida real, solo se refleja el nombre para
    // poder ver el render de la burbuja de usuario con adjuntos (sin miniatura de imagen).
    if (Array.isArray(attachments) && attachments.length > 0) {
      userMsg.attachments = attachments.map((name) => ({ name, type: 'application/octet-stream' }));
    }
    handlers.onMsg && handlers.onMsg(userMsg);
    handlers.onState && handlers.onState('starting');
    setTimeout(() => {
      handlers.onState && handlers.onState('running');
      const toolMsg = {
        id: nextId('t'),
        ts: Date.now(),
        role: 'tool',
        name: 'run_command',
        params: { CommandLine: 'echo CHAT_TOOL_OK' },
        summary: 'echo CHAT_TOOL_OK',
        state: 'active',
      };
      handlers.onMsg && handlers.onMsg(toolMsg);
      setTimeout(() => {
        handlers.onMsg && handlers.onMsg({ ...toolMsg, state: 'done', output: 'CHAT_TOOL_OK\n', durationSeconds: 0.2 });
        const assistantId = nextId('a');
        const full = `Respuesta simulada (modo prueba sin backend) a: "${text.slice(0, 60)}".\n\n\`\`\`bash\necho "línea muy larga de más de doscientos caracteres para comprobar el scroll horizontal propio del bloque de código sin desbordar la página en pantallas estrechas de 390 píxeles de ancho como el iPhone 13 Pro con dpr 3"\n\`\`\`\n`;
        let i = 0;
        const step = () => {
          i += 8;
          const partial = full.slice(0, i);
          handlers.onMsg && handlers.onMsg({ id: assistantId, ts: Date.now(), role: 'assistant', text: partial, done: i >= full.length });
          if (i < full.length) setTimeout(step, 20);
          else handlers.onState && handlers.onState('idle');
        };
        step();
      }, 400);
    }, 300);
  }

  function stop() {
    handlers.onState && handlers.onState('idle');
    handlers.onMsg && handlers.onMsg({ id: nextId('sys'), ts: Date.now(), role: 'system', text: 'Detenido', kind: 'stopped' });
  }

  return {
    send: (text, attachments) => {
      send(text, attachments);
      return { queued: false };
    },
    stop,
    sendRaw: () => {}, // sin backend real: no hay registro crudo que pedir
    on: () => () => {},
    destroy: () => {},
    getQueueLength: () => 0,
    isSimulated: true,
  };
}

// server/chat/ws-chat.js
// WebSocket del modo chat: /ws/chat?chat=<id>. WebSocketServer en modo
// `noServer:true` + dispatch manual sobre `httpServer.on('upgrade')` filtrando
// por pathname (necesario: `{server,path}` de ws aborta con 400 cualquier
// upgrade cuyo path no coincida, en vez de dejarlo para otros listeners —
// rompería la convivencia con /ws). server/ws.js usa el mismo patrón. Mismo
// heartbeat que ws.js.

import { WebSocketServer, WebSocket } from 'ws';
import { wsAuth } from '../auth.js';
import * as store from './store.js';

const HEARTBEAT_INTERVAL_MS = 25_000;
const HELLO_MESSAGE_LIMIT = 200;
const CHAT_ID_RE = /^c_[0-9a-f]{10}$/;

/**
 * @param {import('node:http').Server} httpServer
 * @param {import('./runner.js').ChatManager} manager
 */
export function attachChatWebSocketServer(httpServer, manager) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
      }
      return;
    }
    if (url.pathname !== '/ws/chat') return; // no es para este WS server: se deja para otros listeners
    // La auth se comprueba en 'connection' y se responde con close 4001: un navegador no puede
    // leer el status HTTP de un upgrade rechazado (vería 1006 y reconectaría a ciegas), pero sí
    // el código de cierre, con el que la PWA pide el token (public/js/socket.js).
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        // ignorar
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  wss.on('connection', async (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    try {
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        ws.close(4001, 'unauthorized');
        return;
      }

      if (!wsAuth(url, req)) {
        ws.close(4001, 'unauthorized');
        return;
      }

      const chatId = url.searchParams.get('chat');
      if (!chatId || !CHAT_ID_RE.test(chatId)) {
        ws.close(4004, 'chat required');
        return;
      }

      if (!(await store.chatExists(chatId))) {
        ws.close(4004, 'chat not found');
        return;
      }

      const runner = await manager.getRunner(chatId);
      manager.subscribe(chatId, ws);

      const safeSend = (payload) => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify(payload));
          } catch {
            // ignorar
          }
        }
      };

      const messages = await store.readMessages(chatId, HELLO_MESSAGE_LIMIT);
      safeSend({ t: 'hello', chat: chatId, state: runner.chat.state, messages });

      ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return; // JSON inválido: ignorar
      }
      if (!msg || typeof msg !== 'object') return;

      switch (msg.t) {
        case 'send': {
          const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
          const text = typeof msg.text === 'string' ? msg.text : '';
          if (!text.length && attachments.length === 0) return;
          runner.send(text, attachments).catch((err) => {
            safeSend({ t: 'error', message: err && err.message ? err.message : 'error enviando el mensaje' });
          });
          break;
        }
        case 'stop': {
          runner.stop().catch((err) => {
            safeSend({ t: 'error', message: err && err.message ? err.message : 'error deteniendo el turno' });
          });
          break;
        }
        case 'ping':
          safeSend({ t: 'pong' });
          break;
        case 'raw-sub':
          manager.subscribeRaw(chatId, ws);
          break;
        case 'raw-unsub':
          manager.unsubscribeRaw(chatId, ws);
          break;
        default:
          break;
      }
    });

    const cleanup = () => {
      manager.unsubscribe(chatId, ws);
      manager.unsubscribeRaw(chatId, ws);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
    } catch (err) {
      console.error('[ws-chat] Error initializing websocket connection:', err);
      try {
        ws.close(1011, 'internal error');
      } catch {}
    }
  });

  return wss;
}

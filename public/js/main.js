// public/js/main.js
// Bootstrap: conecta store ⇄ chat ⇄ ui. Punto de entrada único de la app (vista única: chat).

import { api, chatWsUrl, getToken, setToken, UnauthorizedError } from './api.js';
import { t } from './i18n.js';
import { store } from './store.js';
import { initPwa } from './pwa.js';
import { initUpdates } from './updates.js';
import { bindViewport, geometry } from './viewport.js';
window.__agyGeometry = geometry;
import { initTelemetry, reportBoot } from './telemetry.js';
import { toast } from './ui/toast.js';
import * as drawerUi from './ui/drawer.js';
import * as sheetsUi from './ui/sheets.js';
import * as chatViewUi from './chat/chat-view.js';
import * as chatTopbarUi from './chat/chat-topbar.js';
import * as chatDockUi from './chat/chat-dock.js';
import * as newChatUi from './chat/new-chat.js';
import { connectChat } from './chat/chat-socket.js';
import * as agyLogUi from './chat/agy-log.js';

void chatWsUrl; // usado internamente por chat-socket.js

// ---------- Token dialog ----------

let activeTokenPromise = null;

function showTokenDialog({ message } = {}) {
  if (activeTokenPromise) return activeTokenPromise;
  activeTokenPromise = new Promise((resolve) => {
    const root = document.getElementById('token-dialog-root');
    root.innerHTML = '';

    const overlay = document.createElement('div');
    overlay.className = 'token-dialog';

    const box = document.createElement('div');
    box.className = 'token-dialog__box';

    const h2 = document.createElement('h2');
    h2.textContent = t('Token de acceso');
    box.appendChild(h2);

    const p = document.createElement('p');
    p.textContent = message || t('Este servidor requiere un token para autenticarse.');
    box.appendChild(p);

    const field = document.createElement('div');
    field.className = 'field';
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.value = getToken();
    input.placeholder = t('Token');
    field.appendChild(input);
    box.appendChild(field);

    const actions = document.createElement('div');
    actions.className = 'prompt-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = t('Cancelar');
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn--primary';
    saveBtn.textContent = t('Guardar');
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    box.appendChild(actions);

    overlay.appendChild(box);
    root.appendChild(overlay);

    function done(value) {
      root.innerHTML = '';
      activeTokenPromise = null;
      resolve(value);
    }

    cancelBtn.addEventListener('click', () => done(null));
    saveBtn.addEventListener('click', () => done(input.value.trim()));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') done(input.value.trim());
    });

    setTimeout(() => input.focus(), 30);
  });
}

async function withAuthRetry(fn) {
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        const token = await showTokenDialog({ message: t('El token no es válido o hace falta uno nuevo.') });
        if (token === null) throw err;
        setToken(token);
        continue;
      }
      throw err;
    }
  }
}

const apiWithAuth = (path, opts) => withAuthRetry(() => api(path, opts));

// ---------- Chat wiring (vista única) ----------

const chatEmptyEl = document.getElementById('chat-empty');
const chatMessagesEl = document.getElementById('chat-messages');

function showChatEmpty(show) {
  chatEmptyEl.hidden = !show;
  chatMessagesEl.hidden = show;
}

let currentChatController = null;
let currentChatId = null;
let chatBackendWarned = false;

function detachChat() {
  if (currentChatController) {
    currentChatController.destroy();
    currentChatController = null;
  }
  currentChatId = null;
}

function updateChatInList(chat) {
  const exists = store.state.chats.some((c) => c.id === chat.id);
  const list = exists
    ? store.state.chats.map((c) => (c.id === chat.id ? { ...c, ...chat } : c))
    : [chat, ...store.state.chats];
  store.setChats(list);
}

function patchChatStateLocally(id, state) {
  store.setChats(store.state.chats.map((c) => (c.id === id ? { ...c, state } : c)));
}

let currentAttachSeq = 0;

async function attachChat(id) {
  const seq = ++currentAttachSeq;
  detachChat();
  store.setActiveChatId(id);
  currentChatId = id;
  chatViewCtl.clear();
  showChatEmpty(false);

  try {
    const res = await apiWithAuth(`/chats/${encodeURIComponent(id)}?limit=200`);
    if (seq !== currentAttachSeq) return;
    const chat = res && res.chat;
    if (chat) {
      chatViewCtl.setMessages(res.messages || []);
      chatViewCtl.setState(chat.state);
      chatTopbarCtl.setChat(chat);
      chatDockCtl.setChat(chat);
      updateChatInList(chat);
    }
  } catch (err) {
    if (seq !== currentAttachSeq) return;
    if (err && err.status === 404) {
      toast(t('Ese chat ya no existe'), { type: 'error' });
      store.setActiveChatId(null);
      currentChatId = null;
      showChatEmpty(true);
      return;
    }
    if (err.name !== 'UnauthorizedError') {
      toast(t('No se pudo abrir el chat: {message}', { message: err.message }), { type: 'error' });
    }
  }

  if (seq !== currentAttachSeq) return;

  currentChatController = connectChat(id, {
    onHello: (msg) => {
      chatViewCtl.setMessages(msg.messages || []);
      chatViewCtl.setState(msg.state);
      chatDockCtl.setRunning(msg.state);
      patchChatStateLocally(id, msg.state);
    },
    onMsg: (message) => chatViewCtl.upsertMessage(message),
    onState: (state) => {
      chatViewCtl.setState(state);
      chatDockCtl.setRunning(state);
      patchChatStateLocally(id, state);
    },
    onChat: (chat) => {
      chatTopbarCtl.setChat(chat);
      chatDockCtl.setChat(chat);
      updateChatInList(chat);
    },
    onError: (message) => toast(message || t('Error del chat'), { type: 'error' }),
    onGone: () => {
      toast(t('Ese chat ya no existe'), { type: 'error' });
      store.setActiveChatId(null);
      currentChatId = null;
      showChatEmpty(true);
      drawerCtl.refreshChats();
    },
    onUnauthorized: async () => {
      const token = await showTokenDialog({ message: t('El token no es válido para conectar por WebSocket.') });
      if (token !== null) {
        setToken(token);
        attachChat(id);
      }
    },
    onStatus: (s) => store.setChatConnection(s),
  });
}

function sendChatText(text, attachments) {
  if (!currentChatController) {
    toast(t('No hay ningún chat abierto'), { type: 'error' });
    return;
  }
  const result = currentChatController.send(text, attachments);
  if (result.queued) {
    const msg = result.reason === 'offline'
      ? t('Sin conexión: se enviará al reconectar')
      : t('En cola: se enviará cuando termine el turno actual');
    toast(msg, { type: 'info' });
  }
}

function stopChat() {
  if (!currentChatController) return;
  currentChatController.stop();
}

async function patchChat(patch) {
  if (!currentChatId) throw new Error(t('No hay chat activo'));
  const updated = await apiWithAuth(`/chats/${encodeURIComponent(currentChatId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  chatTopbarCtl.setChat(updated);
  chatDockCtl.setChat(updated);
  updateChatInList(updated);
}

async function refreshChats() {
  try {
    const chats = await apiWithAuth('/chats');
    store.setChats(chats);
    return chats;
  } catch (err) {
    if (err && err.status === 404) {
      if (!chatBackendWarned) {
        chatBackendWarned = true;
        toast(t('Backend de chat no disponible todavía'), { type: 'info' });
      }
      store.setChats([]);
      return [];
    }
    if (err.name !== 'UnauthorizedError') {
      toast(t('No se pudieron cargar los chats: {message}', { message: err.message }), { type: 'error' });
    }
    store.setChats([]);
    return [];
  }
}

// ---------- UI mounting ----------

const drawerCtl = drawerUi.mount(document.getElementById('drawer'), document.getElementById('drawer-backdrop'), {
  api: apiWithAuth,
  store,
  toast,
  onSelectChat: (id) => {
    if (id !== currentChatId) attachChat(id);
    drawerCtl.close();
  },
  onOpenNewChat: () => {
    newChatCtl.open();
  },
});

const sheetsCtl = sheetsUi.mount(document.getElementById('sheet'), document.getElementById('sheet-backdrop'));

const newChatCtl = newChatUi.mount(
  document.getElementById('new-chat-sheet'),
  document.getElementById('new-chat-backdrop'),
  {
    api: apiWithAuth,
    toast,
    store,
    onCreated: (chat) => {
      drawerCtl.close();
      updateChatInList(chat);
      attachChat(chat.id);
      drawerCtl.refreshChats();
    },
  },
);

const chatViewCtl = chatViewUi.mount(document.getElementById('chat-messages'));

const chatTopbarCtl = chatTopbarUi.mount(document.getElementById('chat-topbar'), {
  api: apiWithAuth,
  toast,
  sheets: sheetsCtl,
  onMenu: () => drawerCtl.toggle(),
  onRenamed: (chat) => {
    updateChatInList(chat);
    drawerCtl.refreshChats();
  },
  onDeleted: () => {
    detachChat();
    store.setActiveChatId(null);
    store.setChats(store.state.chats.filter((c) => c.id !== currentChatId));
    showChatEmpty(true);
    drawerCtl.refreshChats();
  },
  getThinkingMode: () => chatViewCtl.getThinkingMode(),
  onThinkingMode: (mode) => chatViewCtl.setThinkingMode(mode),
  onOpenLog: () => {
    if (!currentChatId) {
      toast(t('No hay ningún chat abierto'), { type: 'error' });
      return;
    }
    agyLogUi.open({
      sheets: sheetsCtl,
      api: apiWithAuth,
      toast,
      chatId: currentChatId,
      controller: currentChatController,
    });
  },
  onNewConversation: () => {
    const active = store.getActiveChat();
    newChatCtl.open({ cwd: active ? active.cwd : undefined });
  },
});

const chatDockCtl = chatDockUi.mount(
  document.getElementById('chat-composer'),
  {
    api: apiWithAuth,
    toast,
    sheets: sheetsCtl,
    chatId: () => currentChatId,
    onSend: sendChatText,
    onStop: stopChat,
    onPatch: patchChat,
    // comandos de agy que el CLI responde por sí mismo (/usage, /credits…): la salida llega por WS
    // como mensaje de sistema kind 'cli'
    onCommand: async (cmd) => {
      if (!currentChatId) {
        toast(t('No hay ningún chat abierto'), { type: 'error' });
        return;
      }
      toast(t('Ejecutando {cmd}…', { cmd }), { type: 'info' });
      await apiWithAuth(`/chats/${encodeURIComponent(currentChatId)}/command`, { method: 'POST', body: JSON.stringify({ cmd }) });
    },
    // acciones de la app que también se ofrecen en el menú "/" del compositor
    commands: [
      {
        cmd: '/nueva', label: t('Nueva conversación'), desc: t('Empieza otro chat en el mismo proyecto'), icon: 'plus',
        run: () => {
          const active = store.getActiveChat();
          newChatCtl.open({ cwd: active ? active.cwd : undefined });
        },
      },
      {
        cmd: '/registro', label: t('Registro de agy (CLI)'), desc: t('Salida cruda del proceso agy de este chat'), icon: 'file',
        run: () => {
          if (!currentChatId) {
            toast(t('No hay ningún chat abierto'), { type: 'error' });
            return;
          }
          agyLogUi.open({ sheets: sheetsCtl, api: apiWithAuth, toast, chatId: currentChatId, controller: currentChatController });
        },
      },
    ],
  },
);

const chatEmptyTextEl = document.querySelector('#chat-empty p');
if (chatEmptyTextEl) chatEmptyTextEl.textContent = t('No hay ningún chat abierto.');
const chatEmptyNewBtn = document.getElementById('chat-empty-new-btn');
if (chatEmptyNewBtn) {
  chatEmptyNewBtn.textContent = t('＋ Nuevo chat');
  chatEmptyNewBtn.addEventListener('click', () => newChatCtl.open());
}

// ---------- Boot ----------

async function boot() {
  initTelemetry();
  bindViewport();
  initPwa();
  initUpdates({
    api: apiWithAuth,
    // texto sin enviar en el compositor → no recargar sin preguntar
    isBusy: () => Boolean((chatDockCtl.composer.getValue() || '').trim()),
  });

  try {
    await withAuthRetry(() => api('/health'));
  } catch {
    // seguimos igualmente; /api/health no debería requerir auth, pero si el usuario
    // cancela el diálogo continuamos sin sesión activa.
  }

  const chats = await refreshChats();

  const params = new URLSearchParams(location.search);
  const wantsNewChat = params.get('newChat') === '1';

  const activeChatId = store.state.activeChatId;
  const activeChatExists = activeChatId && chats.some((c) => c.id === activeChatId);
  if (activeChatExists) {
    attachChat(activeChatId);
  } else if (chats.length > 0) {
    attachChat(chats[0].id); // más reciente (GET /api/chats viene ordenado por updatedAt desc)
  } else {
    store.setActiveChatId(null);
    showChatEmpty(true);
  }

  if (wantsNewChat) {
    newChatCtl.open();
  } else if (chats.length === 0) {
    drawerCtl.open();
  }

  reportBoot({
    chats: chats.length,
    active: Boolean(store.state.activeChatId),
  });
}

boot();

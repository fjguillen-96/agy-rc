// public/js/ui/drawer.js
// Drawer lateral: sección "Chats" (GET /api/chats: título, carpeta, modelo · esfuerzo,
// hace X, punto de estado; ⋯ → renombrar/borrar) con CTA "＋ Nuevo chat".

import { icon } from './icons.js';
import { getProjectsRoot, relativeToRoot, splitDisplayPath } from './directory.js';

const REFRESH_MS = 10000;

function timeAgo(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'hace un momento';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

function closeCtxMenu() {
  const existing = document.querySelector('.ctx-menu');
  if (existing) existing.remove();
  document.removeEventListener('click', closeCtxMenu, true);
}

/**
 * @param {HTMLElement} root #drawer
 * @param {HTMLElement} backdrop #drawer-backdrop
 * @param {{api: typeof import('../api.js').api, store: import('../store.js').store,
 *          toast: typeof import('../ui/toast.js').toast,
 *          onSelectChat: (id: string) => void,
 *          onOpenNewChat: () => void}} deps
 */
export function mount(root, backdrop, deps) {
  const { api, store, toast, onSelectChat, onOpenNewChat } = deps;

  let refreshTimer = null;
  let isOpen = false;
  let serverVersion = '';
  let projectsRoot = '';
  let chats = [];
  getProjectsRoot(api).then((root_) => {
    projectsRoot = root_;
    renderChats();
  });

  root.innerHTML = `
    <div class="drawer__header">
      <img class="drawer__logo" src="/icons/logo-256.png" alt="">
      <div class="drawer__title">
        <strong class="gradient-text">Antigravity RC</strong>
        <span id="drawer-host">${location.host}</span>
      </div>
    </div>
    <div class="drawer__scroll">
      <div class="drawer__section">
        <div class="drawer__chats" id="drawer-chats"></div>
        <button type="button" class="drawer__new-btn" id="drawer-new-chat-btn">＋ Nuevo chat</button>
      </div>
    </div>
    <div class="drawer__footer">
      <button type="button" class="drawer__install-btn" id="drawer-install-btn" hidden>Instalar</button>
      <div class="drawer__version" id="drawer-version"></div>
    </div>
  `;

  const chatsEl = root.querySelector('#drawer-chats');
  const versionEl = root.querySelector('#drawer-version');
  const installBtn = root.querySelector('#drawer-install-btn');

  root.querySelector('#drawer-new-chat-btn').addEventListener('click', () => {
    onOpenNewChat();
  });
  installBtn.addEventListener('click', async () => {
    const { promptInstall } = await import('../pwa.js');
    promptInstall();
  });

  import('../pwa.js').then(({ onInstallAvailable }) => {
    onInstallAvailable((available) => {
      installBtn.hidden = !available;
    });
  });

  async function fetchHealth() {
    try {
      const health = await api('/health');
      serverVersion = health.version || '';
      versionEl.textContent = `agy-rc v${serverVersion}`;
    } catch {
      versionEl.textContent = '';
    }
  }

  async function fetchChats() {
    try {
      chats = await api('/chats');
    } catch (err) {
      // §backend: /api/chats puede no existir todavía si el backend aún no está desplegado;
      // se degrada a "sin chats" sin romper el drawer (404) y solo avisa en otros errores.
      if (err && err.status !== 404 && err.name !== 'UnauthorizedError') {
        toast(`No se pudieron cargar los chats: ${err.message}`, { type: 'error' });
      }
      chats = [];
    }
    renderChats();
  }

  // ---------- sección Chats ----------

  function renderChats() {
    chatsEl.innerHTML = '';
    const { activeChatId } = store.state;

    if (chats.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'drawer__empty drawer__empty--chats';
      empty.textContent = 'No hay chats todavía.';
      chatsEl.appendChild(empty);
      return;
    }

    for (const chat of chats) {
      chatsEl.appendChild(renderChatRow(chat, chat.id === activeChatId));
    }
  }

  function renderChatRow(chat, active) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.dataset.active = String(active);

    const dot = document.createElement('span');
    dot.className = 'chat-row__dot';
    dot.dataset.state = chat.state || 'idle';
    row.appendChild(dot);

    const main = document.createElement('div');
    main.className = 'chat-row__main';

    const nameRow = document.createElement('div');
    nameRow.className = 'chat-row__name';
    nameRow.textContent = chat.title || '(sin título)';
    main.appendChild(nameRow);

    const displayPath = relativeToRoot(chat.cwd || '', projectsRoot);
    const { last, rest } = splitDisplayPath(displayPath);
    const meta = document.createElement('div');
    meta.className = 'chat-row__meta';
    if (rest) {
      const restSpan = document.createElement('span');
      restSpan.className = 'dim';
      restSpan.textContent = `${rest}/`;
      meta.appendChild(restSpan);
    }
    const ago = timeAgo(chat.updatedAt);
    meta.appendChild(document.createTextNode(last + (ago ? ` · ${ago}` : '')));
    main.appendChild(meta);

    if (chat.model) {
      const agyRow = document.createElement('div');
      agyRow.className = 'chat-row__agy';
      agyRow.textContent = [chat.model, chat.effort].filter(Boolean).join(' · ');
      main.appendChild(agyRow);
    }

    row.appendChild(main);

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'session-row__menu-btn';
    menuBtn.innerHTML = icon('kebab');
    menuBtn.setAttribute('aria-label', 'Opciones del chat');
    menuBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openChatRowMenu(menuBtn, chat);
    });
    row.appendChild(menuBtn);

    row.addEventListener('click', () => onSelectChat(chat.id));

    return row;
  }

  function openChatRowMenu(anchor, chat) {
    closeCtxMenu();
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';

    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.textContent = 'Renombrar';
    renameBtn.addEventListener('click', async () => {
      closeCtxMenu();
      const next = window.prompt('Nuevo título del chat:', chat.title || '');
      if (next === null || !next.trim() || next.trim() === chat.title) return;
      try {
        await api(`/chats/${encodeURIComponent(chat.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ title: next.trim() }),
        });
        await fetchChats();
        toast('Chat renombrado', { type: 'success' });
      } catch (err) {
        toast(`No se pudo renombrar: ${err.message}`, { type: 'error' });
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Borrar chat';
    deleteBtn.addEventListener('click', async () => {
      closeCtxMenu();
      if (!window.confirm(`¿Borrar el chat "${chat.title || chat.id}"?`)) return;
      try {
        await api(`/chats/${encodeURIComponent(chat.id)}`, { method: 'DELETE' });
        await fetchChats();
        toast('Chat borrado', { type: 'success' });
      } catch (err) {
        toast(`No se pudo borrar: ${err.message}`, { type: 'error' });
      }
    });

    menu.appendChild(renameBtn);
    menu.appendChild(deleteBtn);
    document.body.appendChild(menu);

    setTimeout(() => document.addEventListener('click', closeCtxMenu, true), 0);
  }

  store.subscribe(renderChats);

  function startRefresh() {
    stopRefresh();
    refreshTimer = setInterval(() => {
      fetchChats();
    }, REFRESH_MS);
  }

  function stopRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function open() {
    isOpen = true;
    root.dataset.open = 'true';
    backdrop.dataset.open = 'true';
    root.setAttribute('aria-hidden', 'false');
    fetchChats();
    fetchHealth();
    startRefresh();
  }

  function close() {
    isOpen = false;
    root.dataset.open = 'false';
    backdrop.dataset.open = 'false';
    root.setAttribute('aria-hidden', 'true');
    stopRefresh();
  }

  function toggle() {
    if (isOpen) close();
    else open();
  }

  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && isOpen) close();
  });

  return {
    open,
    close,
    toggle,
    isOpen: () => isOpen,
    refreshChats: fetchChats,
  };
}

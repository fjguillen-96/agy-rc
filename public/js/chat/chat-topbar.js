// public/js/chat/chat-topbar.js
// Topbar del modo chat: ☰, título + carpeta relativa, punto de estado, ⋯ (Renombrar,
// Borrar chat, Razonamiento, Registro de agy).

import { icon } from '../ui/icons.js';
import { getProjectsRoot, relativeToRoot } from '../ui/directory.js';

const THINKING_LABEL = { collapsed: 'Plegado', expanded: 'Desplegado', hidden: 'Oculto' };
const THINKING_ORDER = ['collapsed', 'expanded', 'hidden'];
const THINKING_DESC = {
  collapsed: 'El razonamiento aparece plegado; tócalo para desplegarlo.',
  expanded: 'El razonamiento aparece desplegado por defecto.',
  hidden: 'No se muestra el razonamiento (ni los mensajes que son solo pensamiento).',
};

function closeCtxMenu() {
  const existing = document.querySelector('.ctx-menu');
  if (existing) existing.remove();
  document.removeEventListener('click', closeCtxMenu, true);
}

/**
 * @param {HTMLElement} root <header id="chat-topbar">
 * @param {{api: typeof import('../api.js').api, toast: typeof import('../ui/toast.js').toast,
 *          sheets: ReturnType<typeof import('../ui/sheets.js').mount>,
 *          onMenu: () => void, onRenamed: (chat: object) => void, onDeleted: () => void,
 *          onOpenLog: () => void, onNewConversation: () => void,
 *          getThinkingMode: () => string, onThinkingMode: (mode: string) => void}} deps
 */
export function mount(root, deps) {
  const {
    api, toast, sheets, onMenu, onRenamed, onDeleted,
    onOpenLog, onNewConversation, getThinkingMode, onThinkingMode,
  } = deps;

  let projectsRoot = '';
  let current = null;
  getProjectsRoot(api).then((r) => {
    projectsRoot = r;
    render();
  });

  root.innerHTML = `
    <button class="icon-btn" id="chat-btn-menu" type="button" aria-label="Abrir menú">${icon('menu')}</button>
    <div class="topbar__info">
      <span class="topbar__conn-dot" id="chat-topbar-dot" data-status="none"></span>
      <div class="topbar__text" id="chat-topbar-text">
        <span class="topbar__session-name" id="chat-topbar-title">Sin chat</span>
        <span class="topbar__session-cwd" id="chat-topbar-cwd"></span>
      </div>
    </div>
    <button class="icon-btn" id="chat-btn-kebab" type="button" aria-label="Menú del chat">${icon('kebab')}</button>
  `;

  const dot = root.querySelector('#chat-topbar-dot');
  const titleEl = root.querySelector('#chat-topbar-title');
  const cwdEl = root.querySelector('#chat-topbar-cwd');
  const kebabBtn = root.querySelector('#chat-btn-kebab');

  root.querySelector('#chat-btn-menu').addEventListener('click', onMenu);

  function render() {
    if (current) {
      titleEl.textContent = current.title || '(sin título)';
      cwdEl.textContent = relativeToRoot(current.cwd || '', projectsRoot);
      dot.dataset.status = current.state === 'running' || current.state === 'starting' ? 'running' : 'dead';
    } else {
      titleEl.textContent = 'Sin chat';
      cwdEl.textContent = '';
      dot.dataset.status = 'none';
    }
  }

  function setChat(chat) {
    current = chat;
    render();
  }

  function menuItem(iconName, label, onClick, opts = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctx-menu__item';
    if (opts.danger) btn.classList.add('danger');
    btn.innerHTML = `${icon(iconName)}<span>${label}</span>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  async function doRename() {
    if (!current) return;
    const next = window.prompt('Nuevo título del chat:', current.title || '');
    if (next === null || !next.trim() || next.trim() === current.title) return;
    try {
      const updated = await api(`/chats/${encodeURIComponent(current.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: next.trim() }),
      });
      toast('Chat renombrado', { type: 'success' });
      onRenamed(updated);
    } catch (err) {
      toast(`No se pudo renombrar: ${err.message}`, { type: 'error' });
    }
  }

  async function doDelete() {
    if (!current) return;
    if (!window.confirm(`¿Borrar el chat "${current.title || current.id}"?`)) return;
    try {
      await api(`/chats/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
      toast('Chat borrado', { type: 'success' });
      onDeleted();
    } catch (err) {
      toast(`No se pudo borrar: ${err.message}`, { type: 'error' });
    }
  }

  function openThinkingSheet() {
    if (!sheets || !onThinkingMode) return;
    sheets.open('Razonamiento', (body, close) => {
      const currentMode = getThinkingMode ? getThinkingMode() : 'collapsed';
      const list = document.createElement('div');
      list.className = 'option-list';

      for (const mode of THINKING_ORDER) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'option-row option-row--stacked';
        if (currentMode === mode) row.dataset.active = 'true';

        const top = document.createElement('div');
        top.className = 'option-row__top';
        const label = document.createElement('span');
        label.className = 'option-row__label';
        label.textContent = THINKING_LABEL[mode];
        top.appendChild(label);
        if (currentMode === mode) {
          const check = document.createElement('span');
          check.className = 'option-row__check';
          check.innerHTML = icon('check');
          top.appendChild(check);
        }
        row.appendChild(top);

        const desc = document.createElement('div');
        desc.className = 'option-row__desc';
        desc.textContent = THINKING_DESC[mode];
        row.appendChild(desc);

        row.addEventListener('click', () => {
          close();
          if (mode !== currentMode) onThinkingMode(mode);
        });

        list.appendChild(row);
      }

      body.appendChild(list);
    });
  }

  function openMenu() {
    closeCtxMenu();
    if (!current) return;
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    const rect = kebabBtn.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;

    if (onNewConversation) {
      menu.appendChild(menuItem('plus', 'Nueva conversación', () => {
        closeCtxMenu();
        onNewConversation();
      }));
      const sep0 = document.createElement('hr');
      sep0.className = 'ctx-menu__sep';
      menu.appendChild(sep0);
    }

    menu.appendChild(menuItem('pencil', 'Renombrar', doRename));
    menu.appendChild(menuItem('trash', 'Borrar chat', doDelete, { danger: true }));

    const sep1 = document.createElement('hr');
    sep1.className = 'ctx-menu__sep';
    menu.appendChild(sep1);

    const thinkingMode = getThinkingMode ? getThinkingMode() : 'collapsed';
    menu.appendChild(menuItem('spark', `Razonamiento: ${THINKING_LABEL[thinkingMode] || thinkingMode}`, () => {
      closeCtxMenu();
      openThinkingSheet();
    }));
    if (onOpenLog) {
      menu.appendChild(menuItem('file', 'Registro de agy (CLI)', () => {
        closeCtxMenu();
        onOpenLog();
      }));
    }

    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', closeCtxMenu, true), 0);
  }

  kebabBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    openMenu();
  });

  return { setChat };
}

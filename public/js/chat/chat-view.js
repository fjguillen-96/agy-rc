// public/js/chat/chat-view.js
// Lista de mensajes del chat: burbujas usuario/asistente, tarjetas de herramienta, líneas de
// sistema, indicador "pensando…", auto-scroll al fondo (o botón flotante si el usuario ha
// subido). Sin dependencias de terminal.js: solo el modelo de mensajes de CHAT.md §2.1.

import { renderMarkdown } from './markdown.js';
import { renderToolCard, updateToolCard } from './tool-card.js';
import { icon } from '../ui/icons.js';
import { getToken } from '../api.js';

const NEAR_BOTTOM_PX = 80;
const THINKING_KEY = 'agyrc.thinking';
const THINKING_MODES = ['collapsed', 'expanded', 'hidden'];

function formatTime(ts) {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function truncateFileName(name, max = 22) {
  const n = String(name || 'archivo');
  if (n.length <= max) return n;
  const dot = n.lastIndexOf('.');
  const ext = dot > 0 ? n.slice(dot) : '';
  const keep = Math.max(3, max - ext.length - 1);
  return `${n.slice(0, keep)}…${ext}`;
}

function authUrl(url) {
  if (!url) return '';
  const token = getToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

// Miniaturas de imagen: se descargan con `Authorization: Bearer` y se muestran como blob: URL para
// no meter el token en `src` (historial, logs de proxies, "copiar dirección de imagen"…).
// Si fetch falla (sin blob/URL.createObjectURL, red…) se cae a `?token=`.
const blobUrlCache = new Map();
async function loadImageBlobUrl(url) {
  if (blobUrlCache.has(url)) return blobUrlCache.get(url);
  const p = (async () => {
    const headers = new Headers();
    const token = getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(url, { headers, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return URL.createObjectURL(await res.blob());
  })();
  blobUrlCache.set(url, p);
  p.catch(() => blobUrlCache.delete(url));
  return p;
}

/** Fila de miniaturas de adjuntos de una burbuja de usuario (§ adjuntos, PUT /uploads). */
function attachmentsRow(list) {
  const row = document.createElement('div');
  row.className = 'msg-attachments';
  for (const a of list) {
    const isImage = typeof a.type === 'string' && a.type.startsWith('image/');
    if (isImage && a.url) {
      let fullUrl = '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'msg-attachments__img-btn';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = a.name || 'adjunto';
      btn.appendChild(img);
      btn.addEventListener('click', () => { if (fullUrl) window.open(fullUrl, '_blank', 'noopener'); });
      row.appendChild(btn);
      loadImageBlobUrl(a.url)
        .catch(() => authUrl(a.url))
        .then((src) => {
          fullUrl = src;
          img.src = src;
        });
    } else {
      const chip = document.createElement('div');
      chip.className = 'msg-attachments__file';
      chip.innerHTML = icon('file');
      const name = document.createElement('span');
      name.textContent = truncateFileName(a.name);
      chip.appendChild(name);
      row.appendChild(chip);
    }
  }
  return row;
}

function loadThinkingMode() {
  try {
    const v = localStorage.getItem(THINKING_KEY);
    if (THINKING_MODES.includes(v)) return v;
  } catch {
    // localStorage no disponible; usamos el valor por defecto
  }
  return 'collapsed';
}

function saveThinkingMode(mode) {
  try {
    localStorage.setItem(THINKING_KEY, mode);
  } catch {
    // ignorar
  }
}

/**
 * @param {HTMLElement} root contenedor con scroll propio (p.ej. #chat-messages)
 */
export function mount(root) {
  root.innerHTML = `
    <div class="chat-list" id="chat-list"></div>
    <div class="chat-thinking" id="chat-thinking" hidden>
      <span class="chat-thinking__dots"><span></span><span></span><span></span></span>
      <span class="chat-thinking__label">Antigravity está pensando…</span>
    </div>
  `;
  const listEl = root.querySelector('#chat-list');
  const thinkingEl = root.querySelector('#chat-thinking');
  const thinkingLabel = thinkingEl.querySelector('.chat-thinking__label');

  const jumpBtn = document.createElement('button');
  jumpBtn.type = 'button';
  jumpBtn.className = 'chat-jump-btn';
  jumpBtn.hidden = true;
  jumpBtn.innerHTML = `${icon('arrowDownKey')}<span>nuevos mensajes</span>`;
  root.parentElement ? root.parentElement.appendChild(jumpBtn) : root.appendChild(jumpBtn);

  let messages = [];
  let chatState = 'idle';
  const elBysId = new Map(); // msg.id → DOM element
  let thinkingMode = loadThinkingMode(); // 'collapsed' | 'expanded' | 'hidden'
  const openThinking = new Map(); // msg.id → bool (abierto/cerrado explícito por el usuario)

  function isNearBottom() {
    return root.scrollHeight - root.scrollTop - root.clientHeight <= NEAR_BOTTOM_PX;
  }

  function scrollToBottom(force) {
    if (!force && !isNearBottom()) return;
    root.scrollTop = root.scrollHeight;
    jumpBtn.hidden = true;
  }

  root.addEventListener('scroll', () => {
    if (isNearBottom()) jumpBtn.hidden = true;
  });

  jumpBtn.addEventListener('click', () => scrollToBottom(true));

  // Tocar la zona de mensajes repliega el teclado (como en las apps de chat nativas). Solo si el
  // foco está en el compositor; los toques sobre botones/enlaces de las burbujas no se ven afectados
  // porque el blur ocurre antes y el click sigue llegando al elemento tocado.
  root.addEventListener('pointerdown', () => {
    const active = document.activeElement;
    if (active && active.matches('.ccomposer__textarea')) active.blur();
  }, { passive: true });

  function buildThinkingDetails(msg) {
    const details = document.createElement('details');
    details.className = 'msg-thinking';
    const isOpen = openThinking.has(msg.id) ? openThinking.get(msg.id) : thinkingMode === 'expanded';
    details.open = isOpen;

    const summary = document.createElement('summary');
    summary.innerHTML = `${icon('spark')}<span>Razonamiento</span>`;
    details.appendChild(summary);

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'msg-thinking__body';
    bodyDiv.textContent = msg.thinking;
    details.appendChild(bodyDiv);

    details.addEventListener('toggle', () => {
      openThinking.set(msg.id, details.open);
    });

    return details;
  }

  function bubbleFor(msg) {
    if (msg.role === 'user') {
      const el = document.createElement('div');
      el.className = 'msg-row msg-row--user';
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble msg-bubble--user';
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      if (attachments.length > 0) bubble.appendChild(attachmentsRow(attachments));
      if (msg.text) {
        const textEl = document.createElement('div');
        textEl.style.whiteSpace = 'pre-wrap';
        textEl.textContent = msg.text;
        bubble.appendChild(textEl);
      }
      bubble.title = formatTime(msg.ts);
      el.appendChild(bubble);
      return el;
    }
    if (msg.role === 'assistant') {
      const hasThinking = typeof msg.thinking === 'string' && msg.thinking.trim() !== '';
      const thoughtOnly = hasThinking && !msg.text && msg.done;
      if (thoughtOnly && thinkingMode === 'hidden') return null; // solo pensamiento + oculto: no se pinta

      const el = document.createElement('div');
      el.className = 'msg-row msg-row--assistant';
      const body = document.createElement('div');
      body.className = 'msg-assistant';
      if (thoughtOnly) body.classList.add('msg-assistant--thought-only');

      if (hasThinking && thinkingMode !== 'hidden') {
        body.appendChild(buildThinkingDetails(msg));
      }
      if (msg.text) {
        body.appendChild(renderMarkdown(msg.text));
      } else if (!msg.done && !thoughtOnly) {
        const dots = document.createElement('span');
        dots.className = 'msg-assistant__pending';
        body.appendChild(dots);
      }
      if (msg.interrupted) {
        const note = document.createElement('div');
        note.className = 'msg-assistant__note';
        note.textContent = 'Detenido';
        body.appendChild(note);
      }
      body.title = formatTime(msg.ts);
      el.appendChild(body);
      return el;
    }
    if (msg.role === 'tool') {
      const el = document.createElement('div');
      el.className = 'msg-row msg-row--tool';
      el.appendChild(renderToolCard(msg));
      return el;
    }
    // system kind 'cli': salida de un comando de agy (/usage, /credits…) → bloque monoespaciado
    if (msg.kind === 'cli') {
      const el = document.createElement('div');
      el.className = 'msg-row msg-row--cli';
      const box = document.createElement('div');
      box.className = 'msg-cli';
      const head = document.createElement('div');
      head.className = 'msg-cli__head';
      head.innerHTML = `${icon('terminal')}<span></span>`;
      head.querySelector('span').textContent = msg.cmd || 'agy';
      box.appendChild(head);
      const pre = document.createElement('pre');
      pre.className = 'msg-cli__body';
      pre.textContent = msg.text || '';
      box.appendChild(pre);
      box.title = formatTime(msg.ts);
      el.appendChild(box);
      return el;
    }
    // system
    const el = document.createElement('div');
    el.className = 'msg-row msg-row--system';
    const span = document.createElement('span');
    span.className = `msg-system msg-system--${msg.kind || 'info'}`;
    span.textContent = msg.text || '';
    el.appendChild(span);
    return el;
  }

  function renderAll() {
    listEl.innerHTML = '';
    elBysId.clear();
    for (const msg of messages) {
      const el = bubbleFor(msg);
      if (!el) continue;
      el.dataset.msgId = msg.id;
      listEl.appendChild(el);
      elBysId.set(msg.id, el);
    }
    renderThinking();
  }

  function upsertMessage(msg) {
    const wasNearBottom = isNearBottom();
    const idx = messages.findIndex((m) => m.id === msg.id);
    if (idx === -1) {
      messages.push(msg);
    } else {
      messages[idx] = msg;
    }

    const existingEl = elBysId.get(msg.id);
    const existingCard = existingEl && msg.role === 'tool' ? existingEl.querySelector('.tool-card') : null;
    if (existingCard) {
      updateToolCard(existingCard, msg);
    } else {
      const fresh = bubbleFor(msg);
      if (fresh) fresh.dataset.msgId = msg.id;
      if (existingEl) {
        if (fresh) {
          existingEl.replaceWith(fresh);
          elBysId.set(msg.id, fresh);
        } else {
          existingEl.remove();
          elBysId.delete(msg.id);
        }
      } else if (fresh) {
        listEl.appendChild(fresh);
        elBysId.set(msg.id, fresh);
      }
    }

    renderThinking();
    if (wasNearBottom) scrollToBottom(true);
    else jumpBtn.hidden = false;
  }

  function setMessages(list) {
    messages = Array.isArray(list) ? list.slice() : [];
    renderAll();
    scrollToBottom(true);
  }

  function renderThinking() {
    const last = messages[messages.length - 1];
    const lastOpenAssistant = last && last.role === 'assistant' && !last.done;
    const showStarting = chatState === 'starting';
    const showRunningNoText = chatState === 'running' && (!last || last.role !== 'assistant' || (!last.text && !last.done));
    const show = showStarting || (showRunningNoText && !lastOpenAssistant) || (lastOpenAssistant && !last.text);
    thinkingEl.hidden = !show;
    thinkingLabel.textContent = showStarting ? 'Iniciando Antigravity…' : 'Antigravity está pensando…';
    if (show) scrollToBottom(false);
  }

  function setState(state) {
    chatState = state;
    renderThinking();
  }

  function clear() {
    messages = [];
    renderAll();
  }

  function setThinkingMode(mode) {
    if (!THINKING_MODES.includes(mode)) return;
    thinkingMode = mode;
    saveThinkingMode(mode);
    renderAll();
  }

  function getThinkingMode() {
    return thinkingMode;
  }

  return {
    setMessages,
    upsertMessage,
    setState,
    clear,
    scrollToBottom,
    isNearBottom,
    setThinkingMode,
    getThinkingMode,
  };
}

// public/js/chat/agy-log.js
// Sheet "Registro de agy": historial crudo del proceso CLI (stdin/stdout/stderr/eventos del
// runner) para un chat. Carga `GET /api/chats/:id/log`, luego se suscribe en vivo por el WS
// del chat ({t:'raw-sub'} / {t:'raw', entries}) mientras el sheet está abierto.
//
// El backend (log, raw-sub) lo implementa otro agente en paralelo: si `GET .../log` falla
// (404/500/red), se avisa con toast y el sheet queda vacío en vez de romper.

import { icon } from '../ui/icons.js';

const MAX_ENTRIES = 2000;
const DELTA_MAX = 80;

function truncate(s, max) {
  const str = String(s);
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

/** Formatea una línea `out` (NDJSON del stdout de agy) para la vista Compacto. */
function formatOutLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return line;
  }
  if (!obj || typeof obj !== 'object') return line;

  if (obj.type === 'init') {
    const cwd = (obj.init && obj.init.cwd) || obj.cwd || '?';
    const conv = obj.conversation_id || (obj.init && obj.init.conversation_id) || '?';
    return `init cwd=${cwd} conv=${conv}`;
  }
  if (obj.type === 'step_update') {
    let s = `step#${obj.step_index ?? '?'} ${obj.step_type || ''} ${obj.state || ''}`.replace(/\s+/g, ' ').trim();
    if (obj.tool_name) s += ` ${obj.tool_name}`;
    if (obj.text_delta) s += ` Δ"${truncate(obj.text_delta, DELTA_MAX)}"`;
    const errMsg = obj.tool_info && obj.tool_info.error && obj.tool_info.error.message;
    if (errMsg) s += ` !${errMsg}`;
    return s;
  }
  if (obj.type === 'result') {
    let s = `result ${obj.status || ''}`.trim();
    if (obj.error) s += ` err=${obj.error}`;
    return s;
  }
  return line;
}

function compactLine(entry) {
  if (entry.src === 'cmd') return { cls: 'agy-log__line--cmd', text: `$ ${entry.line}` };
  if (entry.src === 'sys') return { cls: 'agy-log__line--sys', text: `# ${entry.line}` };
  if (entry.src === 'err') return { cls: 'agy-log__line--err', text: `! ${entry.line}` };
  return { cls: '', text: formatOutLine(entry.line) };
}

/**
 * Abre el sheet "Registro de agy" para el chat dado.
 * @param {{sheets: ReturnType<typeof import('../ui/sheets.js').mount>,
 *          api: typeof import('../api.js').api, toast: typeof import('../ui/toast.js').toast,
 *          chatId: string, controller: ReturnType<typeof import('./chat-socket.js').connectChat>|null}} opts
 */
export function open({ sheets, api, toast, chatId, controller }) {
  sheets.open('Registro de agy', (body, close) => {
    void close; // el cierre real se detecta por MutationObserver (ver abajo)

    const sheetRoot = body.closest('.sheet');
    if (sheetRoot) sheetRoot.classList.add('sheet--tall');

    let entries = [];
    let tab = 'compact'; // 'compact' | 'raw'
    let cleaned = false;
    let unsubscribeRaw = null;
    let subscribedRaw = false;

    body.classList.add('agy-log-body');

    const toolbar = document.createElement('div');
    toolbar.className = 'agy-log__toolbar';

    const seg = document.createElement('div');
    seg.className = 'segmented';
    const compactBtn = document.createElement('button');
    compactBtn.type = 'button';
    compactBtn.className = 'segmented__opt';
    compactBtn.textContent = 'Compacto';
    compactBtn.dataset.active = 'true';
    const rawBtn = document.createElement('button');
    rawBtn.type = 'button';
    rawBtn.className = 'segmented__opt';
    rawBtn.textContent = 'Crudo';
    seg.appendChild(compactBtn);
    seg.appendChild(rawBtn);
    toolbar.appendChild(seg);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn agy-log__clear-btn';
    clearBtn.textContent = 'Limpiar vista';
    toolbar.appendChild(clearBtn);

    const listWrap = document.createElement('div');
    listWrap.className = 'agy-log__list';

    body.appendChild(toolbar);
    body.appendChild(listWrap);

    function isNearBottom() {
      return listWrap.scrollHeight - listWrap.scrollTop - listWrap.clientHeight <= 40;
    }

    function scrollBottom() {
      listWrap.scrollTop = listWrap.scrollHeight;
    }

    function lineEl(entry) {
      const div = document.createElement('div');
      div.className = 'agy-log__line';
      if (tab === 'raw') {
        div.textContent = entry.line;
      } else {
        const { cls, text } = compactLine(entry);
        if (cls) div.classList.add(cls);
        div.textContent = text;
      }
      return div;
    }

    function renderAllLines() {
      listWrap.classList.toggle('agy-log__list--raw', tab === 'raw');
      listWrap.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (const entry of entries) frag.appendChild(lineEl(entry));
      listWrap.appendChild(frag);
      scrollBottom();
    }

    function appendLines(newOnes) {
      const wasBottom = isNearBottom();
      const frag = document.createDocumentFragment();
      for (const entry of newOnes) frag.appendChild(lineEl(entry));
      listWrap.appendChild(frag);
      while (listWrap.children.length > MAX_ENTRIES) listWrap.removeChild(listWrap.firstChild);
      if (wasBottom) scrollBottom();
    }

    function pushEntries(list) {
      if (!Array.isArray(list) || list.length === 0) return;
      entries.push(...list);
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
      appendLines(list);
    }

    compactBtn.addEventListener('click', () => {
      if (tab === 'compact') return;
      tab = 'compact';
      compactBtn.dataset.active = 'true';
      delete rawBtn.dataset.active;
      renderAllLines();
    });
    rawBtn.addEventListener('click', () => {
      if (tab === 'raw') return;
      tab = 'raw';
      rawBtn.dataset.active = 'true';
      delete compactBtn.dataset.active;
      renderAllLines();
    });
    clearBtn.addEventListener('click', () => {
      entries = [];
      renderAllLines();
    });

    async function loadInitial() {
      listWrap.innerHTML = '<div class="sheet__loading">Cargando…</div>';
      try {
        const res = await api(`/chats/${encodeURIComponent(chatId)}/log?limit=500`);
        const list = res && Array.isArray(res.entries) ? res.entries : [];
        entries = list.slice(-MAX_ENTRIES);
        renderAllLines();
      } catch (err) {
        listWrap.innerHTML = '<p class="sheet__hint">No se pudo cargar el registro.</p>';
        toast(`No se pudo cargar el registro de agy: ${err.message}`, { type: 'error' });
      }
    }

    function subscribeRaw() {
      if (!controller || typeof controller.on !== 'function' || typeof controller.sendRaw !== 'function') return;
      unsubscribeRaw = controller.on('raw', (newEntries) => pushEntries(newEntries));
      controller.sendRaw({ t: 'raw-sub' });
      subscribedRaw = true;
    }

    function unsubscribeRawFeed() {
      if (subscribedRaw && controller && typeof controller.sendRaw === 'function') {
        try {
          controller.sendRaw({ t: 'raw-unsub' });
        } catch {
          // socket ya cerrado; nada que hacer
        }
      }
      if (unsubscribeRaw) {
        unsubscribeRaw();
        unsubscribeRaw = null;
      }
      subscribedRaw = false;
    }

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      unsubscribeRawFeed();
      if (sheetRoot) sheetRoot.classList.remove('sheet--tall');
      observer.disconnect();
    }

    // Detecta el cierre del sheet (backdrop/Escape/✕) por el cambio de aria-hidden, o que
    // otro `sheets.open(...)` haya reemplazado nuestro contenido sin pasar por el cierre.
    const observer = new MutationObserver(() => {
      const hidden = sheetRoot && sheetRoot.getAttribute('aria-hidden') === 'true';
      const replaced = !body.contains(listWrap);
      if (hidden || replaced) cleanup();
    });
    if (sheetRoot) observer.observe(sheetRoot, { attributes: true, attributeFilter: ['aria-hidden'] });
    observer.observe(body, { childList: true });

    loadInitial().then(subscribeRaw);
  });
}

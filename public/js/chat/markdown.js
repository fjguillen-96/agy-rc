// public/js/chat/markdown.js
// Envoltorio de marked + DOMPurify (globals servidos por /vendor/…): markdown de mensajes
// assistant → HTMLElement seguro. NUNCA usar innerHTML sin pasar por DOMPurify.

let configured = false;

function ensureConfigured() {
  if (configured) return;
  configured = true;
  if (typeof marked !== 'undefined' && marked.setOptions) {
    marked.setOptions({ breaks: true, gfm: true });
  }
}

/**
 * Renderiza markdown a un HTMLElement seguro (sanitizado con DOMPurify). Si `marked` o
 * `DOMPurify` no están disponibles (fallo de red/CDN), degrada a texto plano preformateado.
 * @param {string} text
 * @returns {HTMLElement}
 */
export function renderMarkdown(text) {
  const wrap = document.createElement('div');
  wrap.className = 'markdown';
  const src = String(text || '');

  const canRender = typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined';
  if (!canRender) {
    wrap.classList.add('markdown--plain');
    wrap.style.whiteSpace = 'pre-wrap';
    wrap.textContent = src;
    return wrap;
  }

  ensureConfigured();
  let html;
  try {
    html = marked.parse(src);
  } catch {
    wrap.classList.add('markdown--plain');
    wrap.style.whiteSpace = 'pre-wrap';
    wrap.textContent = src;
    return wrap;
  }

  const clean = DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
    FORBID_TAGS: ['img', 'style'],
  });
  wrap.innerHTML = clean;

  // Enlaces: abrir en pestaña nueva sin filtrar el opener.
  wrap.querySelectorAll('a[href]').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });

  // Bloques de código: envoltorio con scroll horizontal propio, nunca desborda la página.
  wrap.querySelectorAll('pre').forEach((pre) => {
    pre.classList.add('markdown__pre');
    const code = pre.querySelector('code');
    if (code) code.classList.add('markdown__code');
  });

  wrap.querySelectorAll('table').forEach((table) => {
    const scroller = document.createElement('div');
    scroller.className = 'markdown__table-scroll';
    table.parentNode.insertBefore(scroller, table);
    scroller.appendChild(table);
  });

  return wrap;
}

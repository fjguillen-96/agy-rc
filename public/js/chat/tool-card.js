// public/js/chat/tool-card.js
// Tarjeta plegable de mensaje `role:'tool'`: icono según nombre, nombre legible, `summary`
// truncado en monoespaciada, estado (spinner si activo, rojo si error). Al tocar despliega
// `output`/`error` en <pre> con scroll propio.

import { icon } from '../ui/icons.js';
import { t } from '../i18n.js';

const NAME_ICON = {
  run_command: 'terminal',
  view_file: 'file',
  write_to_file: 'file',
  replace_file_content: 'file',
  multi_replace_file_content: 'file',
  sed_file: 'file',
  list_dir: 'folder',
  find_by_name: 'search',
  grep_search: 'search',
  search_web: 'globe',
  read_url_content: 'globe',
};

const NAME_LABEL = {
  run_command: 'Comando',
  view_file: 'Leer archivo',
  write_to_file: 'Escribir archivo',
  replace_file_content: 'Editar archivo',
  multi_replace_file_content: 'Editar archivo',
  sed_file: 'Editar archivo',
  list_dir: 'Listar carpeta',
  grep_search: 'Buscar',
  find_by_name: 'Buscar',
  search_web: 'Buscar en la web',
  read_url_content: 'Leer URL',
};

function iconForTool(name) {
  return NAME_ICON[name] || 'gear';
}

function labelForTool(name) {
  return NAME_LABEL[name] ? t(NAME_LABEL[name]) : String(name || t('Herramienta'));
}

/**
 * @param {object} msg mensaje role:'tool' (§2.1 CHAT.md)
 * @returns {HTMLElement}
 */
export function renderToolCard(msg) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.dataset.state = msg.state || 'done';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'tool-card__head';

  const iconWrap = document.createElement('span');
  iconWrap.className = 'tool-card__icon';
  iconWrap.innerHTML = icon(iconForTool(msg.name));
  head.appendChild(iconWrap);

  const main = document.createElement('span');
  main.className = 'tool-card__main';

  const nameEl = document.createElement('span');
  nameEl.className = 'tool-card__name';
  nameEl.textContent = labelForTool(msg.name);
  main.appendChild(nameEl);

  if (msg.summary) {
    const summaryEl = document.createElement('span');
    summaryEl.className = 'tool-card__summary';
    summaryEl.textContent = msg.summary;
    main.appendChild(summaryEl);
  }

  head.appendChild(main);

  const statusEl = document.createElement('span');
  statusEl.className = 'tool-card__status';
  if (msg.state === 'active') {
    statusEl.innerHTML = '<span class="tool-card__spinner" aria-hidden="true"></span>';
  } else if (msg.state === 'error') {
    statusEl.innerHTML = icon('close');
    statusEl.classList.add('tool-card__status--error');
  } else {
    statusEl.innerHTML = icon('chevronDown');
    statusEl.classList.add('tool-card__chevron');
  }
  head.appendChild(statusEl);

  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'tool-card__body';
  body.hidden = true;

  const hasDetail = Boolean(msg.output || msg.error);
  if (hasDetail) {
    const pre = document.createElement('pre');
    pre.className = 'tool-card__pre';
    if (msg.error) pre.classList.add('tool-card__pre--error');
    pre.textContent = msg.error || msg.output || '';
    body.appendChild(pre);
  } else {
    const empty = document.createElement('div');
    empty.className = 'tool-card__empty';
    empty.textContent = msg.state === 'active' ? t('En curso…') : t('Sin salida');
    body.appendChild(empty);
  }
  card.appendChild(body);

  head.addEventListener('click', () => {
    const willShow = body.hidden;
    body.hidden = !willShow;
    card.dataset.open = String(willShow);
  });

  return card;
}

/**
 * Actualiza una tarjeta existente in-place (evita perder el estado abierto/cerrado al
 * reconstruir la lista en cada upsert de mensaje).
 * @param {HTMLElement} card
 * @param {object} msg
 */
export function updateToolCard(card, msg) {
  const fresh = renderToolCard(msg);
  const wasOpen = card.dataset.open === 'true';
  if (wasOpen) {
    fresh.dataset.open = 'true';
    const body = fresh.querySelector('.tool-card__body');
    if (body) body.hidden = false;
  }
  card.replaceWith(fresh);
  return fresh;
}

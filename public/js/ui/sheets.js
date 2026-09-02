// public/js/ui/sheets.js
// Bottom sheet genérico y reutilizable: título + cuerpo construido por el llamante.
// Lo usan controls.js (modelo / esfuerzo / modo / comandos) y composer.js (historial).

import { icon } from './icons.js';

/**
 * @param {HTMLElement} root #sheet
 * @param {HTMLElement} backdrop #sheet-backdrop
 */
export function mount(root, backdrop) {
  let isOpen = false;

  root.innerHTML = `
    <div class="sheet__handle"></div>
    <div class="sheet__header">
      <h2 id="sheet-title"></h2>
      <button type="button" class="sheet__close" aria-label="Cerrar">${icon('close')}</button>
    </div>
    <div class="sheet__body" id="sheet-body"></div>
  `;

  const titleEl = root.querySelector('#sheet-title');
  const bodyEl = root.querySelector('#sheet-body');
  const closeBtn = root.querySelector('.sheet__close');

  function close() {
    if (!isOpen) return;
    isOpen = false;
    root.dataset.open = 'false';
    backdrop.dataset.open = 'false';
    root.setAttribute('aria-hidden', 'true');
  }

  /**
   * @param {string} title
   * @param {(body: HTMLElement, close: () => void) => void} build
   */
  function open(title, build) {
    isOpen = true;
    titleEl.textContent = title;
    bodyEl.innerHTML = '';
    root.dataset.open = 'true';
    backdrop.dataset.open = 'true';
    root.setAttribute('aria-hidden', 'false');
    build(bodyEl, close);
  }

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && isOpen) close();
  });

  return { open, close, isOpen: () => isOpen };
}

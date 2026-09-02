// public/js/ui/toast.js
// Toasts simples apilados sobre la action bar.

let stackEl = null;

function ensureStack() {
  if (!stackEl) {
    stackEl = document.getElementById('toast-stack');
  }
  return stackEl;
}

/**
 * @param {string} message
 * @param {{type?: 'info'|'success'|'error', duration?: number}} [opts]
 */
export function toast(message, opts = {}) {
  const { type = 'info', duration = 3200 } = opts;
  const stack = ensureStack();
  if (!stack) return;

  const el = document.createElement('div');
  el.className = `toast${type !== 'info' ? ` toast--${type}` : ''}`;
  el.textContent = message;
  stack.appendChild(el);

  requestAnimationFrame(() => {
    el.dataset.show = 'true';
  });

  const remove = () => {
    el.dataset.show = 'false';
    setTimeout(() => el.remove(), 220);
  };

  const timer = setTimeout(remove, duration);
  el.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });
}

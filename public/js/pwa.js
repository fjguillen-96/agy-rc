// public/js/pwa.js
// Registro del service worker (solo en contexto seguro), captura de
// beforeinstallprompt y aviso discreto cuando no hay HTTPS.

import { t } from './i18n.js';

const INSECURE_DISMISS_KEY = 'agyrc.insecureBannerDismissed';

let deferredInstallPrompt = null;
const installListeners = new Set();

export function onInstallAvailable(fn) {
  installListeners.add(fn);
  if (deferredInstallPrompt) fn(true);
  return () => installListeners.delete(fn);
}

export async function promptInstall() {
  if (!deferredInstallPrompt) return false;
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice.catch(() => null);
  deferredInstallPrompt = null;
  for (const fn of installListeners) fn(false);
  return choice ? choice.outcome === 'accepted' : false;
}

window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  deferredInstallPrompt = ev;
  for (const fn of installListeners) fn(true);
});

function showInsecureBanner() {
  try {
    if (localStorage.getItem(INSECURE_DISMISS_KEY) === '1') return;
  } catch {
    // ignore
  }
  const root = document.getElementById('insecure-banner-root');
  if (!root) return;

  const banner = document.createElement('div');
  banner.className = 'insecure-banner';
  banner.innerHTML = `
    <span>${t('Para instalar la app hace falta HTTPS: usa {cmd} (ver README).', { cmd: '<code>tailscale serve</code>' })}</span>
    <button type="button" aria-label="${t('Cerrar aviso')}">✕</button>
  `;
  banner.querySelector('button').addEventListener('click', () => {
    banner.remove();
    try {
      localStorage.setItem(INSECURE_DISMISS_KEY, '1');
    } catch {
      // ignore
    }
  });
  root.appendChild(banner);
}

export function initPwa() {
  if (window.isSecureContext) {
    if ('serviceWorker' in navigator) {
      const register = () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
          // registro fallido: la app sigue funcionando sin SW
        });
      };
      // 'load' puede haber disparado ya (boot() corre desde un módulo diferido)
      if (document.readyState === 'complete') register();
      else window.addEventListener('load', register, { once: true });
    }
  } else {
    showInsecureBanner();
  }
}

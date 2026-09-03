// public/js/updates.js
// Detección de versión nueva sin depender del service worker (en HTTP no hay SW): compara el
// `build` de /api/health con el que tenía la página al arrancar. Se comprueba al reconectar un
// WebSocket (un despliegue reinicia el servidor → los WS caen y vuelven), al volver a primer
// plano y cada 10 min. Al detectarla: banner "Nueva versión disponible"; si no hay texto sin
// enviar, se actualiza sola en unos segundos. La recarga no pierde nada (todo vive en el servidor).

import { t } from './i18n.js';

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const AUTO_APPLY_DELAY_MS = 4000;
const MIN_GAP_MS = 5000; // no machacar /api/health si varios WS reconectan a la vez

let bootBuild = null;
let latestBuild = null;
let lastCheckAt = 0;
let banner = null;
let autoTimer = null;

/**
 * @param {{api: (path: string) => Promise<any>, isBusy: () => boolean}} deps
 *   isBusy: true si hay texto sin enviar (entonces no se recarga sola).
 */
export function initUpdates({ api, isBusy }) {
  const check = async (reason) => {
    const now = Date.now();
    if (now - lastCheckAt < MIN_GAP_MS) return;
    lastCheckAt = now;
    let health;
    try {
      health = await api('/health');
    } catch {
      return;
    }
    if (!health || typeof health.build !== 'string') return;
    if (bootBuild === null) {
      bootBuild = health.build;
      return;
    }
    if (health.build !== bootBuild && health.build !== latestBuild) {
      latestBuild = health.build;
      console.info(`[updates] build nuevo ${health.build} (actual ${bootBuild}) vía ${reason}`);
      showBanner(isBusy);
    }
  };

  check('boot');
  window.addEventListener('agyrc:ws-reconnected', () => check('ws-reconnect'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check('visible');
  });
  setInterval(() => check('interval'), CHECK_INTERVAL_MS);
}

async function applyUpdate() {
  if (banner) banner.querySelector('.update-banner__text').textContent = t('Actualizando…');
  try {
    // Con SW (HTTPS): forzar la comprobación del sw.js nuevo; su install hace skipWaiting y
    // clients.claim, así que tras update() ya controla la página y la recarga trae lo nuevo.
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await Promise.race([reg.update(), new Promise((r) => setTimeout(r, 4000))]);
  } catch {
    // sin SW o fallo al actualizarlo: la recarga con Cache-Control: no-cache basta
  }
  location.reload();
}

function showBanner(isBusy) {
  if (banner) return;
  const root = document.getElementById('insecure-banner-root') || document.body;
  banner = document.createElement('div');
  banner.className = 'update-banner';
  banner.setAttribute('role', 'status');
  banner.innerHTML = `
    <span class="update-banner__text">${t('Nueva versión disponible')}</span>
    <button type="button" class="update-banner__later" aria-label="${t('Más tarde')}">${t('Más tarde')}</button>
    <button type="button" class="update-banner__apply">${t('Actualizar')}</button>
  `;
  banner.querySelector('.update-banner__apply').addEventListener('click', () => {
    clearTimeout(autoTimer);
    applyUpdate();
  });
  banner.querySelector('.update-banner__later').addEventListener('click', () => {
    clearTimeout(autoTimer);
    banner.remove();
    banner = null;
    // seguirá disponible: al siguiente cambio de build (o recarga manual) se aplica
  });
  root.appendChild(banner);

  const scheduleAuto = () => {
    autoTimer = setTimeout(() => {
      if (!banner) return;
      if (isBusy()) {
        banner.querySelector('.update-banner__text').textContent = t('Nueva versión disponible · toca Actualizar cuando termines');
        return; // el usuario tiene texto sin enviar: no le pisamos la recarga
      }
      applyUpdate();
    }, AUTO_APPLY_DELAY_MS);
  };
  if (!isBusy()) {
    banner.querySelector('.update-banner__text').textContent = t('Nueva versión disponible · actualizando en unos segundos');
  }
  scheduleAuto();
}

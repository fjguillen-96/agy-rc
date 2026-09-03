// public/js/telemetry.js
// Diagnóstico remoto mínimo: errores JS no capturados, promesas rechazadas y un ping de
// arranque (tiempo de carga + user agent) se envían al servidor, que los escribe en su
// journal. Permite depurar el móvil (iOS Safari) sin acceso a sus devtools.

import { getToken } from './api.js';

const ENDPOINT = '/api/client-log';
let sent = 0;

export function post(payload) {
  if (sent >= 20) return; // no inundar
  sent += 1;
  try {
    const body = JSON.stringify({ ...payload, url: location.pathname + location.search });
    // fetch (no sendBeacon): sendBeacon no puede mandar Authorization y daba 401 con AGY_TOKEN.
    const token = getToken();
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // nunca debe romper la app
  }
}

export function initTelemetry() {
  window.addEventListener('error', (ev) => {
    post({ type: 'error', message: ev.message || String(ev.error || 'error'), stack: ev.error?.stack, extra: { src: ev.filename, line: ev.lineno, col: ev.colno } });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    post({ type: 'rejection', message: (r && (r.message || String(r))) || 'rejection', stack: r?.stack });
  });
}

/** Llamar cuando la app está lista e interactiva. */
export function reportBoot(extra = {}) {
  let geo = {};
  try { geo = window.__agyGeometry ? window.__agyGeometry() : {}; } catch { geo = {}; }
  const nav = performance.getEntriesByType?.('navigation')?.[0];
  post({
    type: 'boot',
    ms: performance.now(),
    message: 'app lista',
    extra: {
      ...extra,
      ...geo,
      secure: window.isSecureContext,
      standalone: window.matchMedia?.('(display-mode: standalone)')?.matches || navigator.standalone === true,
      vp: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio,
      ttfb: nav ? Math.round(nav.responseStart) : undefined,
      domLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : undefined,
    },
  });
}

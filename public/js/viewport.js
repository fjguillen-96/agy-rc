// public/js/viewport.js
// Teclado virtual como *overlay* (iOS siempre; Android vía interactive-widget=overlays-content):
// el layout de #app NUNCA se encoge (así la conversación no se re-ajusta al abrir el teclado).
// Solo el dock (chips + compositor) se desplaza hacia arriba la altura del teclado, calculada
// con el visualViewport. Es el mismo patrón que usan las apps de chat en PWA.

import { post } from './telemetry.js';

const KB_MIN_PX = 80;
let lastOpen = null;

export function isKeyboardOpen() {
  return document.documentElement.dataset.kbOpen === '1';
}

/** Geometría real para diagnóstico remoto (iOS). */
export function geometry() {
  const vv = window.visualViewport;
  const app = document.getElementById('app');
  const r = app ? app.getBoundingClientRect() : null;
  const cs = getComputedStyle(document.documentElement);
  return {
    inner: `${window.innerWidth}x${window.innerHeight}`,
    vv: vv ? `${Math.round(vv.width)}x${Math.round(vv.height)}@${Math.round(vv.offsetTop)}/${Math.round(vv.pageTop)}` : null,
    scrollY: Math.round(window.scrollY),
    docH: document.documentElement.scrollHeight,
    app: r ? `top=${Math.round(r.top)} h=${Math.round(r.height)} bottom=${Math.round(r.bottom)}` : null,
    safe: `${cs.getPropertyValue('--safe-top').trim()}/${cs.getPropertyValue('--safe-bottom').trim()}`,
    active: document.activeElement?.tagName,
    dock: dockGeometry(vv),
  };
}

/** Dónde queda el dock visible respecto al borde inferior del visual viewport (diagnóstico). */
function dockGeometry(vv) {
  const dock = [...document.querySelectorAll('.dock')].find((d) => d.offsetParent !== null);
  if (!dock || !vv) return null;
  const r = dock.getBoundingClientRect();
  const vvBottom = vv.offsetTop + vv.height;
  return `bottom=${Math.round(r.bottom)} vvBottom=${Math.round(vvBottom)} gap=${Math.round(vvBottom - r.bottom)} kb=${getComputedStyle(document.documentElement).getPropertyValue('--kb').trim()}`;
}

export function bindViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  if (!vv) return;
  // al perder el foco un campo (teclado que se cierra), reajustar el scroll del WebView
  document.addEventListener('focusout', () => setTimeout(resetScroll, 80));
  // si la ventana llega a desplazarse (no debería: body fijo), informar una vez
  let reportedScroll = false;
  window.addEventListener('scroll', () => {
    if (!reportedScroll && window.scrollY > 4) {
      reportedScroll = true;
      post({ type: 'scroll', message: 'ventana desplazada', extra: geometry() });
    }
  }, { passive: true });

  // Altura máxima vista sin teclado: referencia para detectar el teclado también cuando iOS
  // encoge el layout viewport entero (visto en iOS 18.7: innerHeight pasa de 797 a 394 y la
  // fórmula de abajo da 0 aunque el teclado esté abierto).
  let fullHeight = Math.max(window.innerHeight, vv.height);
  const apply = () => {
    if (document.activeElement === document.body || !document.activeElement) {
      fullHeight = Math.max(fullHeight, window.innerHeight, vv.height);
    }
    // Zona tapada por el teclado en coordenadas del layout viewport (si iOS no lo encoge)
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    const shrunk = fullHeight - vv.height; // cuánto ha encogido lo visible respecto a la pantalla completa
    const open = kb > KB_MIN_PX || shrunk > KB_MIN_PX;
    root.style.setProperty('--kb', `${open ? kb : 0}px`);
    if (open) root.dataset.kbOpen = '1';
    else delete root.dataset.kbOpen;
    if (open !== lastOpen) {
      const wasOpen = lastOpen;
      lastOpen = open;
      root.dispatchEvent(new CustomEvent('kb-change', { detail: { open, kb } }));
      // iOS instalada (standalone): al ocultarse el teclado el WebView puede quedarse desplazado
      // hacia arriba. Reajuste puntual (no continuo) al cerrar.
      if (wasOpen && !open) setTimeout(resetScroll, 50);
      // telemetría de diagnóstico (iOS): una línea por apertura/cierre, con geometría
      post({ type: 'kb', message: open ? 'teclado abierto' : 'teclado cerrado', extra: { kb, ...geometry() } });
    }
  };

  function resetScroll() {
    try {
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
      const se = document.scrollingElement;
      if (se && se.scrollTop !== 0) se.scrollTop = 0;
    } catch {
      // ignore
    }
  }

  // iOS instalada: si la pantalla menos el viewport ya equivale a la barra de estado, el WebView
  // ya la ha descontado y env(safe-area-inset-top) la volvería a sumar → la anulamos.
  const fixDoubleSafeArea = () => {
    try {
      const cs = getComputedStyle(root);
      const safeTop = Number.parseFloat(cs.getPropertyValue('--safe-top')) || 0;
      const gap = (window.screen?.height || 0) - window.innerHeight;
      if (safeTop > 0 && gap >= safeTop - 2 && gap <= safeTop + 40) {
        root.style.setProperty('--safe-top', '0px');
        post({ type: 'layout', message: 'safe-top anulado (viewport ya excluye la barra de estado)', extra: { safeTop, gap, ...geometry() } });
      }
    } catch {
      // ignore
    }
  };
  fixDoubleSafeArea();
  setTimeout(fixDoubleSafeArea, 300);
  setTimeout(() => post({ type: 'layout', message: 'geometría tras arrancar', extra: geometry() }), 2500);

  apply();
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 300));
}

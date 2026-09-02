// server/index.js
// Arranque: express + http + ws (chat); estáticos /public y /vendor; re-adopción de chats en tmux.

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { buildId, renderServiceWorker } from './build.js';
import { router } from './routes.js';
import { listModels } from './agy.js';
import { createChatRouter } from './chat/routes.js';
import { attachChatWebSocketServer } from './chat/ws-chat.js';
import { attachTranscribeWebSocketServer } from './transcribe.js';
import { ChatManager } from './chat/runner.js';

// Un único ChatManager por proceso (registro de ChatRunner por chat + broadcast WS).
export const chatManager = new ChatManager();

/**
 * Construye la app express (sin arrancar el servidor). Usado también por tests.
 */
export function createApp({ chatRouterDeps } = {}) {
  const app = express();
  app.disable('x-powered-by');

  function sanitizeUrl(urlStr) {
    try {
      const u = new URL(urlStr, 'http://localhost');
      if (u.searchParams.has('token')) {
        u.searchParams.set('token', '***');
      }
      return u.pathname + (u.search ? u.search : '');
    } catch {
      return urlStr;
    }
  }

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      console.log(`${req.method} ${sanitizeUrl(req.originalUrl)} ${res.statusCode} ${ms}ms`);
    });
    next();
  });

  app.use('/api', router);
  app.use('/api', createChatRouter(chatManager, chatRouterDeps));

  // -- service worker con nombre de caché ligado al build (ver build.js) -----
  const swSource = readFileSync(path.join(config.publicDir, 'sw.js'), 'utf8');
  app.get('/sw.js', (req, res) => {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(renderServiceWorker(swSource, buildId));
  });

  // -- estáticos: shell de la app. no-cache = revalidar siempre con ETag (304 baratos),
  //    para que una recarga tras desplegar traiga el código nuevo también sin SW (HTTP).
  const staticOpts = { etag: true, cacheControl: true, maxAge: 0, setHeaders: (res) => res.set('Cache-Control', 'no-cache') };
  app.use(express.static(config.publicDir, { index: 'index.html', ...staticOpts }));

  // -- vendor: bundles UMD servidos directamente desde node_modules -------
  const vendorMounts = [
    ['/vendor/marked', path.join(config.rootDir, 'node_modules', 'marked', 'lib')],
    ['/vendor/dompurify', path.join(config.rootDir, 'node_modules', 'dompurify', 'dist')],
  ];
  for (const [route, dir] of vendorMounts) {
    app.use(route, express.static(dir, staticOpts));
  }

  // -- fallback SPA: cualquier GET no-API no encontrado → index.html -----
  app.get(/^(?!\/api).*/, (req, res, next) => {
    res.sendFile(path.join(config.publicDir, 'index.html'), (err) => {
      if (err) next(err);
    });
  });

  return app;
}

function main() {
  const app = createApp();
  const server = http.createServer(app);
  attachChatWebSocketServer(server, chatManager);
  attachTranscribeWebSocketServer(server);

  // Precalienta la caché de `agy models` (tarda unos segundos la primera vez)
  listModels().catch(() => {});
  server.listen(config.PORT, config.HOST, () => {
    console.log(
      `agy-rc v${config.version} escuchando en http://${config.HOST}:${config.PORT} ` +
        `(tmux socket: ${config.AGY_TMUX_SOCKET}, proyectos: ${config.AGY_PROJECTS_ROOT})`
    );
    if ((config.HOST === '0.0.0.0' || config.HOST === '::') && !config.AGY_TOKEN) {
      console.warn(
        `\x1b[33m[AVISO DE SEGURIDAD] Servidor escuchando en ${config.HOST}:${config.PORT} sin AGY_TOKEN configurado.\n` +
        `Cualquier equipo con acceso de red puede ejecutar comandos en este equipo.\n` +
        `Recomendado: genera un token con 'openssl rand -hex 24' y configúralo en .env\x1b[0m`
      );
    }
    // Re-adopta los agy que siguieron vivos en tmux mientras el servidor estaba parado y limpia
    // sesiones chat-* de chats ya borrados. Tras listen para que la app responda cuanto antes.
    chatManager
      .restoreAll()
      .then((n) => { if (n > 0) console.log(`[agy-rc] ${n} chat(s) re-adoptados desde tmux`); })
      .catch((err) => console.error('[agy-rc] error re-adoptando chats desde tmux:', err));
  });

  const shutdown = (signal) => {
    console.log(`[agy-rc] recibido ${signal}, cerrando servidor (el tmux server sigue vivo)...`);
    server.close(() => {
      process.exit(0);
    });
    // No esperar a que agonicen conexiones keep-alive/WS abiertas.
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    // Por si aun así server.close() no resuelve, forzar salida tras un margen.
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}

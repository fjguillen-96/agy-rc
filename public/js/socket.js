// public/js/socket.js
// ReconnectingSocket: WebSocket con backoff, reconexión en visibilitychange/online,
// ping periódico y eventos open/binary/control/close/status.
//
// Estado expuesto vía evento 'status': { state: 'connecting'|'open'|'reconnecting'|'closed', attempt, nextIn }

const MIN_BACKOFF = 500;
const MAX_BACKOFF = 10000;
const PING_INTERVAL = 20000;

export class ReconnectingSocket extends EventTarget {
  /**
   * @param {() => string} urlFactory devuelve la URL actual (puede cambiar cols/rows)
   */
  constructor(urlFactory) {
    super();
    this.urlFactory = urlFactory;
    this.ws = null;
    this.deliberateClose = false;
    this.attempt = 0;
    this.backoffTimer = null;
    this.pingTimer = null;
    this.state = 'closed';

    this._onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          this._reconnectNow();
        }
      }
    };
    this._onOnline = () => this._reconnectNow();

    document.addEventListener('visibilitychange', this._onVisibility);
    window.addEventListener('online', this._onOnline);
  }

  connect() {
    this.deliberateClose = false;
    this._open();
  }

  _open() {
    this._clearBackoffTimer();
    this._setState('connecting');
    let url;
    try {
      url = this.urlFactory();
    } catch {
      this._scheduleReconnect();
      return;
    }

    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      this._scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    // Guarda contra sockets obsoletos: tras _reconnectNow()/close() el ws antiguo
    // sigue emitiendo eventos; si ya no es el actual, se ignoran.
    const isStale = () => this.ws !== ws;

    ws.addEventListener('open', () => {
      if (isStale()) return;
      const wasReconnect = this.attempt > 0;
      this._setState('open');
      this.dispatchEvent(new Event('open'));
      // Un despliegue reinicia el servidor y tira todos los WS: al volver, updates.js comprueba el build.
      if (wasReconnect) window.dispatchEvent(new CustomEvent('agyrc:ws-reconnected'));
      this._startPing();
    });

    ws.addEventListener('message', (ev) => {
      if (isStale()) return;
      if (typeof ev.data === 'string') {
        let msg = null;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg && (msg.t === 'ready' || msg.t === 'hello')) {
          this.attempt = 0; // 'ready' = WS terminal, 'hello' = WS chat
        }
        if (msg && msg.t === 'pong') {
          // no-op, solo mantiene viva la conexión
        }
        this.dispatchEvent(new CustomEvent('control', { detail: msg }));
      } else {
        const buf = ev.data instanceof ArrayBuffer ? ev.data : null;
        if (buf) {
          this.dispatchEvent(new CustomEvent('binary', { detail: buf }));
        }
      }
    });

    ws.addEventListener('close', (ev) => {
      if (isStale()) return;
      this._stopPing();
      const code = ev.code;
      this.ws = null;

      if (code === 4004) {
        this._setState('closed');
        this.dispatchEvent(new CustomEvent('gone'));
        this.dispatchEvent(new Event('close'));
        return;
      }
      if (code === 4001) {
        this._setState('closed');
        this.dispatchEvent(new CustomEvent('unauthorized'));
        this.dispatchEvent(new Event('close'));
        return;
      }

      this.dispatchEvent(new Event('close'));

      if (this.deliberateClose) {
        this._setState('closed');
        return;
      }
      this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // el 'close' subsiguiente gestiona la reconexión
    });
  }

  _scheduleReconnect() {
    this.attempt += 1;
    const base = Math.min(MIN_BACKOFF * 2 ** (this.attempt - 1), MAX_BACKOFF);
    const jitter = Math.random() * 300;
    const nextIn = Math.round(base + jitter);
    this._setState('reconnecting', { attempt: this.attempt, nextIn });
    this._clearBackoffTimer();
    this.backoffTimer = setTimeout(() => this._open(), nextIn);
  }

  _reconnectNow() {
    if (this.deliberateClose) return;
    this._clearBackoffTimer();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this._open();
  }

  _clearBackoffTimer() {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ t: 'ping' }));
      }
    }, PING_INTERVAL);
  }

  _stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _setState(state, extra = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('status', { detail: { state, ...extra } }));
  }

  isOpen() {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  /**
   * @param {string|ArrayBuffer|ArrayBufferView} data
   * @returns {boolean}
   */
  send(data) {
    if (this.isOpen()) {
      try {
        this.ws.send(data);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** Cierre deliberado: no reconecta. */
  close() {
    this.deliberateClose = true;
    this._clearBackoffTimer();
    this._stopPing();
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this._setState('closed');
  }

  destroy() {
    this.close();
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('online', this._onOnline);
  }
}

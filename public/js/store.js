// public/js/store.js
// Estado global mínimo: chats, chat activo y estado de conexión del chat. Sin framework.

const ACTIVE_CHAT_KEY = 'agyrc.activeChat';

function readKey(key) {
  try {
    return localStorage.getItem(key) || null;
  } catch {
    return null;
  }
}

function writeKey(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

class Store {
  constructor() {
    this.state = {
      chats: [],
      activeChatId: readKey(ACTIVE_CHAT_KEY),
      chatConnection: { state: 'closed' },
    };
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  setChats(chats) {
    this.state = { ...this.state, chats };
    this._emit();
  }

  setActiveChatId(id) {
    writeKey(ACTIVE_CHAT_KEY, id);
    this.state = { ...this.state, activeChatId: id };
    this._emit();
  }

  setChatConnection(connection) {
    this.state = { ...this.state, chatConnection: connection };
    this._emit();
  }

  getActiveChat() {
    return this.state.chats.find((c) => c.id === this.state.activeChatId) || null;
  }
}

export const store = new Store();

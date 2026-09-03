// public/js/i18n.js
// Idioma de la interfaz (es | en). Las cadenas del código fuente están en español y hacen de
// clave: `t('Nuevo chat')` devuelve la clave tal cual en español y su traducción en inglés
// (diccionario EN al final). Las claves con prefijo `sys.` son mensajes generados por el
// servidor (system messages con `key` + `params`) y tienen entrada en ambos idiomas.
//
// Cambiar de idioma recarga la página: la UI se monta con innerHTML en muchos sitios y es la
// forma más simple y robusta de re-renderizar todo.

const LANG_KEY = 'agyrc.lang';
export const SUPPORTED = ['es', 'en'];

function readStored() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return SUPPORTED.includes(v) ? v : null;
  } catch {
    return null;
  }
}

/** Idioma por defecto según el navegador: español si `navigator.language` empieza por "es". */
export function detectLang() {
  const nav = typeof navigator !== 'undefined' ? navigator.language || '' : '';
  return /^es\b/i.test(nav) ? 'es' : 'en';
}

let current = readStored() || detectLang();

export function getLang() {
  return current;
}

/** Guarda el idioma (sin recargar). Devuelve true si cambió. */
export function setLang(lang) {
  if (!SUPPORTED.includes(lang) || lang === current) return false;
  current = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // sin localStorage: vale para esta sesión
  }
  applyDocumentLang();
  return true;
}

/** Alterna es ⇄ en y recarga para re-renderizar toda la UI. */
export function toggleLang() {
  setLang(current === 'es' ? 'en' : 'es');
  location.reload();
}

export function applyDocumentLang() {
  if (typeof document === 'undefined') return;
  if (document.documentElement) document.documentElement.lang = current;
  // el manifest de la PWA (nombre de accesos directos, descripción) también va por idioma
  const link = document.querySelector('link[rel="manifest"]');
  if (link) link.href = current === 'es' ? '/manifest.es.json' : '/manifest.json';
}

/** Locale BCP-47 para Intl / dictado (es-ES | en-US). */
export function locale() {
  return current === 'es' ? 'es-ES' : 'en-US';
}

function interpolate(s, params) {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined && params[k] !== null ? String(params[k]) : m));
}

/**
 * Traduce una clave (texto en español o clave `sys.*`) al idioma actual.
 * @param {string} key
 * @param {Record<string, string|number>} [params] sustituye `{nombre}` en el texto
 * @returns {string}
 */
export function t(key, params) {
  const dict = current === 'en' ? EN : ES;
  let s = dict[key];
  if (s === undefined) s = key; // sin traducción: la clave ya es el texto en español
  return interpolate(s, params);
}

/**
 * Elige el idioma de un valor que puede venir localizado desde el servidor:
 * `{es: '...', en: '...'}` → texto del idioma actual; string → tal cual.
 */
export function pick(value) {
  if (value && typeof value === 'object') return value[current] || value.es || value.en || '';
  return value == null ? '' : String(value);
}

/**
 * Texto de un mensaje system del servidor: usa `key`/`params` si vienen (traducible), si no `text`.
 * @param {{text?: string, key?: string, params?: object}} msg
 */
export function systemText(msg) {
  if (!msg || !msg.key || (EN[msg.key] === undefined && ES[msg.key] === undefined)) return (msg && msg.text) || '';
  const p = { ...(msg.params || {}) };
  if (msg.key === 'sys.init' || msg.key === 'sys.init.resumed') {
    // el servidor manda los valores crudos; los textos por defecto y el modo se traducen aquí
    p.model = p.model || t('sys.model.default');
    p.effort = p.effort || t('sys.effort.default');
    p.mode = p.mode === 'plan' || p.mode === 'accept-edits' ? t(`sys.mode.${p.mode}`) : '';
  } else if (msg.key === 'sys.cliFailed') {
    p.message = p.message || t('sys.cliFailed.generic');
  }
  return t(msg.key, p);
}

// Mensajes generados por el servidor (system messages con `key`): entrada en ambos idiomas.
const ES = {
  'sys.init': 'Antigravity en {cwd} · auto-aprobar {autoApprove} · {model} · {effort}{mode}',
  'sys.init.resumed': 'Antigravity reanudado en {cwd} · auto-aprobar {autoApprove} · {model} · {effort}{mode}',
  'sys.mode.plan': ' · modo plan',
  'sys.mode.accept-edits': ' · modo aceptar ediciones',
  'sys.model.default': 'modelo por defecto',
  'sys.effort.default': 'por defecto',
  'sys.stopped': 'Detenido',
  'sys.exit': 'Antigravity terminó (código {code})',
  'sys.turnError': 'Error en el turno de Antigravity',
  'sys.sendFailed': 'No se pudo enviar el mensaje a Antigravity: {message}',
  'sys.permissionDenied':
    'Antigravity denegó un permiso porque el auto-aprobado está desactivado. Activa "Auto-aprobar herramientas" en los ajustes del chat, o usa el modo Plan para revisar antes de ejecutar.',
  'sys.cliFailed': '{cmd}: {message}',
  'sys.cliFailed.generic': 'falló',
};

const EN = {
  'sys.init': 'Antigravity in {cwd} · auto-approve {autoApprove} · {model} · {effort}{mode}',
  'sys.init.resumed': 'Antigravity resumed in {cwd} · auto-approve {autoApprove} · {model} · {effort}{mode}',
  'sys.mode.plan': ' · plan mode',
  'sys.mode.accept-edits': ' · accept-edits mode',
  'sys.model.default': 'default model',
  'sys.effort.default': 'default',
  'sys.stopped': 'Stopped',
  'sys.exit': 'Antigravity exited (code {code})',
  'sys.turnError': 'Error during the Antigravity turn',
  'sys.sendFailed': 'Could not send the message to Antigravity: {message}',
  'sys.permissionDenied':
    'Antigravity denied a permission because auto-approve is off. Enable "Auto-approve tools" in the chat settings, or use Plan mode to review before executing.',
  'sys.cliFailed': '{cmd}: {message}',
  'sys.cliFailed.generic': 'failed',

  // ---- UI (clave = texto en español) ----
  //<UI-EN>
  '¿Borrar el chat "{title}"?': 'Delete chat "{title}"?',
  '"{name}" supera 30 MB': '"{name}" exceeds 30 MB',
  '(sin título)': '(untitled)',
  '/ (raíz)': '/ (root)',
  '＋ Nuevo chat': '＋ New chat',
  '~ (raíz)': '~ (root)',
  'Abrir menú': 'Open menu',
  'Aceptar ediciones': 'Accept edits',
  'Activar auto-aprobar': 'Enable auto-approve',
  'Actualizando…': 'Updating…',
  'Actualizar': 'Update',
  'Adjuntar': 'Attach',
  'adjunto': 'attachment',
  'Alto': 'High',
  'Antigravity ejecuta comandos y edita archivos sin preguntar. Desactívalo para modo Plan o si quieres revisar.': 'Antigravity runs commands and edits files without asking. Turn it off for Plan mode or if you want to review.',
  'Antigravity está pensando…': 'Antigravity is thinking…',
  'Antigravity trabajará en esta carpeta': 'Antigravity will work in this folder',
  'Aplica ediciones de archivos automáticamente; sigue pidiendo permiso para comandos sensibles.': 'Applies file edits automatically; still asks permission for sensitive commands.',
  'App': 'App',
  'archivo': 'file',
  'Archivos': 'Files',
  'Auto-aprobar herramientas': 'Auto-approve tools',
  'Backend de chat no disponible todavía': 'Chat backend not available yet',
  'Bajo': 'Low',
  'Bajo · Medio · Alto': 'Low · Medium · High',
  'Borrar chat': 'Delete chat',
  'Buscar': 'Search',
  'Buscar en la web': 'Search the web',
  'Cámara': 'Camera',
  'Cámara, fotos o archivos': 'Camera, photos or files',
  'Cambiar esfuerzo': 'Change effort',
  'Cambiar idioma': 'Change language',
  'Cambiar modelo': 'Change model',
  'Cancelar': 'Cancel',
  'Cancelar y descartar': 'Cancel and discard',
  'Cargando conversaciones…': 'Loading conversations…',
  'Cargando modelos…': 'Loading models…',
  'Cargando…': 'Loading…',
  'Carpeta creada': 'Folder created',
  'Carpeta de trabajo': 'Working folder',
  'Carpeta fijada por defecto (toca para desfijar)': 'Pinned as default folder (tap to unpin)',
  'Carpeta seleccionada': 'Selected folder',
  'Cerrar': 'Close',
  'Cerrar aviso': 'Dismiss notice',
  'Chat borrado': 'Chat deleted',
  'Chat renombrado': 'Chat renamed',
  'Comando': 'Command',
  'Comandos': 'Commands',
  'Compacto': 'Compact',
  'Crear': 'Create',
  'Crear chat': 'Create chat',
  'Crudo': 'Raw',
  'Desactivar auto-aprobar': 'Disable auto-approve',
  'desconocido': 'unknown',
  'Desplegado': 'Expanded',
  'Detener': 'Stop',
  'Detenido': 'Stopped',
  'Dictado por voz': 'Voice dictation',
  'Editar archivo': 'Edit file',
  'Ejecutando {cmd}…': 'Running {cmd}…',
  'El micrófono requiere conexión segura (HTTPS). Accede a través de tu URL HTTPS de Tailscale': 'The microphone requires a secure connection (HTTPS). Open the app through your Tailscale HTTPS URL',
  'El razonamiento aparece desplegado por defecto.': 'Reasoning appears expanded by default.',
  'El razonamiento aparece plegado; tócalo para desplegarlo.': 'Reasoning appears collapsed; tap it to expand.',
  'El token no es válido o hace falta uno nuevo.': 'The token is invalid or a new one is required.',
  'El token no es válido para conectar por WebSocket.': 'The token is not valid for the WebSocket connection.',
  'Elige el modelo de Antigravity': 'Choose the Antigravity model',
  'Empieza otro chat en el mismo proyecto': 'Start another chat in the same project',
  'En cola: se enviará cuando termine el turno actual': 'Queued: it will be sent when the current turn finishes',
  'En curso…': 'In progress…',
  'Enviar': 'Send',
  'Error al acceder al micrófono ({name})': 'Error accessing the microphone ({name})',
  'Error del chat': 'Chat error',
  'Error Gemini Transcribe: {message}': 'Gemini Transcribe error: {message}',
  'Escribir archivo': 'Write file',
  'Ese chat ya no existe': 'That chat no longer exists',
  'Esfuerzo': 'Effort',
  'Este navegador no soporta grabación directa de audio en esta vista': 'This browser does not support direct audio recording in this view',
  'Este navegador no soporta reconocimiento de voz nativo': 'This browser does not support native speech recognition',
  'Este servidor requiere un token para autenticarse.': 'This server requires a token to authenticate.',
  'Fijada "{folder}" como carpeta por defecto': '"{folder}" pinned as default folder',
  'Fijar': 'Pin',
  'Fijar como carpeta por defecto': 'Pin as default folder',
  'Fijar como carpeta por defecto para nuevos chats': 'Pin as default folder for new chats',
  'Finalizar': 'Finish',
  'Finalizar y transcribir': 'Finish and transcribe',
  'Fotos': 'Photos',
  'Fuerza a Antigravity a analizar el código como si fuera nuevo, sin reutilizar el índice ni la memoria previa de esta carpeta.': 'Forces Antigravity to analyze the code as if it were new, without reusing this folder\'s previous index or memory.',
  'Gemini no detectó voz en el audio': 'Gemini did not detect any speech in the audio',
  'Guardar': 'Save',
  'hace {n} d': '{n} d ago',
  'hace {n} h': '{n} h ago',
  'hace {n} min': '{n} min ago',
  'hace un momento': 'just now',
  'Herramienta': 'Tool',
  'Inicializar repositorio git': 'Initialize git repository',
  'Iniciando Antigravity…': 'Starting Antigravity…',
  'Inicio ~': 'Home ~',
  'Instalar': 'Install',
  'Interrumpe el turno en curso': 'Interrupts the current turn',
  'Ir a {path}': 'Go to {path}',
  'Ir a la carpeta personal ~': 'Go to home folder ~',
  'Ir a la raíz del sistema /': 'Go to system root /',
  'Leer archivo': 'Read file',
  'Leer URL': 'Read URL',
  'Limpiar vista': 'Clear view',
  'Listar carpeta': 'List folder',
  'Más tarde': 'Later',
  'Máximo {n} adjuntos': 'Maximum {n} attachments',
  'Medio': 'Medium',
  'Mensaje para Antigravity…': 'Message Antigravity…',
  'Menú del chat': 'Chat menu',
  'Micrófono denegado: toca "aA" en la barra de URL de Safari -> Configuración del sitio web -> Micrófono: Permitir': 'Microphone denied: tap "aA" in Safari\'s URL bar -> Website Settings -> Microphone: Allow',
  'Modelo': 'Model',
  'Modo': 'Mode',
  'Modo Normal · Plan · Aceptar ediciones y auto-aprobar': 'Normal · Plan · Accept edits mode and auto-approve',
  'Ningún comando coincide': 'No command matches',
  'No disponible (se usará el modelo por defecto)': 'Not available (the default model will be used)',
  'No hay chat activo': 'No active chat',
  'No hay chats todavía.': 'No chats yet.',
  'No hay conversaciones anteriores.': 'No previous conversations.',
  'No hay ningún chat abierto': 'No chat is open',
  'No hay ningún chat abierto.': 'No chat is open.',
  'No se muestra el razonamiento (ni los mensajes que son solo pensamiento).': 'Reasoning is not shown (nor messages that are only thinking).',
  'No se pudieron cargar las conversaciones: {message}': 'Could not load conversations: {message}',
  'No se pudieron cargar los chats: {message}': 'Could not load the chats: {message}',
  'No se pudo abrir el chat: {message}': 'Could not open the chat: {message}',
  'No se pudo aplicar el cambio: {message}': 'Could not apply the change: {message}',
  'No se pudo borrar: {message}': 'Could not delete: {message}',
  'No se pudo cargar el registro de agy: {message}': 'Could not load the agy log: {message}',
  'No se pudo cargar el registro.': 'Could not load the log.',
  'No se pudo crear el chat': 'Could not create the chat',
  'No se pudo crear la carpeta': 'Could not create the folder',
  'No se pudo listar el directorio: {message}': 'Could not list the directory: {message}',
  'No se pudo obtener la lista de modelos.': 'Could not fetch the model list.',
  'No se pudo reanudar la conversación': 'Could not resume the conversation',
  'No se pudo renombrar: {message}': 'Could not rename: {message}',
  'No se pudo subir el adjunto: {message}': 'Could not upload the attachment: {message}',
  'No se pudo usar el dictado': 'Could not use dictation',
  'nombre-del-proyecto': 'project-name',
  'Normal': 'Normal',
  'Nueva carpeta': 'New folder',
  'Nueva conversación': 'New conversation',
  'Nueva versión disponible': 'New version available',
  'Nueva versión disponible · actualizando en unos segundos': 'New version available · updating in a few seconds',
  'Nueva versión disponible · toca Actualizar cuando termines': 'New version available · tap Update when you\'re done',
  'Nuevo chat': 'New chat',
  'Nuevo título del chat:': 'New chat title:',
  'nuevos mensajes': 'new messages',
  'Oculto': 'Hidden',
  'Opciones del chat': 'Chat options',
  'Para instalar la app hace falta HTTPS: usa {cmd} (ver README).': 'Installing the app requires HTTPS: use {cmd} (see README).',
  'Permisos de edición': 'Edit permissions',
  'Permite el micrófono en Ajustes › Safari': 'Allow the microphone in Settings › Safari',
  'Pide confirmación antes de cada acción y cada edición de archivo.': 'Asks for confirmation before every action and every file edit.',
  'Plan': 'Plan',
  'Plegado': 'Collapsed',
  'Ponle un nombre a la carpeta': 'Give the folder a name',
  'Por defecto': 'Default',
  'Por defecto: {label}': 'Default: {label}',
  'Quitar adjunto': 'Remove attachment',
  'Razonamiento': 'Reasoning',
  'Razonamiento: {mode}': 'Reasoning: {mode}',
  'Reanudar conversación anterior…': 'Resume previous conversation…',
  'Registro de agy': 'agy log',
  'Registro de agy (CLI)': 'agy log (CLI)',
  'Reindexar proyecto desde cero': 'Reindex project from scratch',
  'Renombrar': 'Rename',
  'Ruta manual': 'Manual path',
  'Ruta relativa a proyectos': 'Path relative to projects',
  'Salida cruda del proceso agy de este chat': 'Raw output of this chat\'s agy process',
  'Se aplicará en el próximo mensaje': 'It will apply from the next message',
  'Se quitó la carpeta por defecto': 'Default folder removed',
  'Se usa el primer mensaje si lo dejas vacío': 'The first message is used if left empty',
  'Sin chat': 'No chat',
  'Sin conexión: se enviará al reconectar': 'Offline: it will be sent when reconnected',
  'Sin modelos': 'No models',
  'Sin salida': 'No output',
  'Sin subcarpetas en este nivel': 'No subfolders at this level',
  'Solo investiga y planifica: no ejecuta ni edita hasta que apruebes el plan.': 'Only researches and plans: it doesn\'t run or edit anything until you approve the plan.',
  'Subir': 'Up',
  'Subir un nivel': 'Go up one level',
  'Título (opcional)': 'Title (optional)',
  'Token': 'Token',
  'Token de acceso': 'Access token',
  'Transcribiendo con Gemini 3.5…': 'Transcribing with Gemini 3.5…',
  'Última: {label}': 'Last: {label}',
  'Volver': 'Back',
  //</UI-EN>
};

applyDocumentLang();

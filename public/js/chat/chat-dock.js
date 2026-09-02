// public/js/chat/chat-dock.js
// Compositor del chat estilo app móvil: tarjeta redondeada (.ccomposer) con adjuntos,
// textarea auto-grow y una fila de controles ＋ · Modelo · Esfuerzo · Permisos de edición ·
// (espacio flexible) · Micrófono · Enviar/Detener. Compositor propio: ya no reutiliza
// mountComposer de composer.js (eso sigue siendo exclusivo del modo terminal).

import { icon } from '../ui/icons.js';
import { post } from '../telemetry.js';
import { cleanSpeechText } from './speech-cleaner.js';

// Idioma del dictado (Web Speech y limpieza fonética): el del navegador, es-ES si es español.
const dictLang = typeof navigator !== 'undefined' && /^es/i.test(navigator.language || '') ? 'es-ES' : 'en-US';

const MODE_LABEL = { normal: 'Normal', plan: 'Plan', 'accept-edits': 'Aceptar ediciones' };
const MODE_ORDER = ['normal', 'plan', 'accept-edits'];
const EFFORT_LABEL = { low: 'Bajo', medium: 'Medio', high: 'Alto' };
const MODE_DESC = {
  normal: 'Pide confirmación antes de cada acción y cada edición de archivo.',
  plan: 'Solo investiga y planifica: no ejecuta ni edita hasta que apruebes el plan.',
  'accept-edits': 'Aplica ediciones de archivos automáticamente; sigue pidiendo permiso para comandos sensibles.',
};
const AUTOAPPROVE_DESC = 'Antigravity ejecuta comandos y edita archivos sin preguntar. Desactívalo para modo Plan o si quieres revisar.';

const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;
const MAX_LINES = 6;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function truncateName(name, max = 16) {
  const n = String(name || '');
  if (n.length <= max) return n;
  const dot = n.lastIndexOf('.');
  const ext = dot > 0 ? n.slice(dot) : '';
  const keep = Math.max(3, max - ext.length - 1);
  return `${n.slice(0, keep)}…${ext}`;
}

function supportsSpeech() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/**
 * @param {HTMLElement} root contenedor único del compositor (p.ej. #chat-composer)
 * @param {{api: typeof import('../api.js').api, toast: typeof import('../ui/toast.js').toast,
 *          sheets: ReturnType<typeof import('../ui/sheets.js').mount>,
 *          chatId: () => string|null,
 *          onSend: (text: string, attachments: string[]) => void, onStop: () => void,
 *          onPatch: (patch: object) => Promise<void>|void,
 *          onCommand?: (cmd: string) => Promise<void>|void,
 *          commands?: Array<{cmd: string, label: string, desc?: string, icon?: string, run: () => void}>}} deps
 *        `commands`: acciones externas (nueva conversación, registro…) que se suman al menú "/".
 *        `onCommand`: ejecuta un comando de agy de tipo 'cli' (/usage, /credits…) → POST /chats/:id/command.
 */
export function mount(root, deps) {
  const { api, toast, sheets, chatId, onSend, onStop, onPatch, onCommand, commands: extraCommands = [] } = deps;

  let chat = null;
  let runningState = 'idle';
  let modelsPromise = null;
  let pending = []; // {id, file, previewUrl, status:'pending'|'uploading'}
  let uploading = false;
  let attId = 0;

  root.innerHTML = `
    <div class="ccomposer__slash" id="cc-slash" role="listbox" aria-label="Comandos" hidden></div>
    <div class="ccomposer__attachments" id="cc-attachments" hidden></div>
    <div class="ccomposer__rec-bar" id="cc-rec-bar" hidden>
      <div class="ccomposer__rec-meta">
        <span class="ccomposer__rec-dot"></span>
        <span class="ccomposer__rec-timer" id="cc-rec-timer">0:00</span>
      </div>
      <div class="ccomposer__rec-wave">
        <canvas id="cc-rec-canvas" height="36"></canvas>
      </div>
      <div class="ccomposer__rec-ctrls" id="cc-rec-ctrls">
        <button type="button" class="ccomposer__rec-action ccomposer__rec-action--cancel" id="cc-rec-cancel" title="Cancelar y descartar" aria-label="Cancelar">${icon('close')}</button>
        <button type="button" class="ccomposer__rec-action ccomposer__rec-action--done" id="cc-rec-done" title="Finalizar y transcribir" aria-label="Finalizar">${icon('check')}</button>
      </div>
      <div class="ccomposer__rec-transcribing" id="cc-rec-transcribing" hidden>
        <span class="ccomposer__rec-spinner"></span>
        <span>Transcribiendo con Gemini 3.5…</span>
      </div>
    </div>
    <textarea class="ccomposer__textarea" id="cc-textarea" placeholder="Mensaje para Antigravity…"
      autocapitalize="sentences" autocomplete="off" spellcheck="true" rows="1"></textarea>
    <div class="ccomposer__row">
      <button type="button" class="ccomposer__icon-btn" id="cc-plus" aria-label="Adjuntar">${icon('plus')}</button>
      <div class="ccomposer__chips" id="cc-chips"></div>
      <button type="button" class="ccomposer__icon-btn ccomposer__mic" id="cc-mic" aria-label="Dictado por voz" aria-pressed="false">${icon('mic')}</button>
      <button type="button" class="ccomposer__send" id="cc-send" aria-label="Enviar">${icon('send')}</button>
    </div>
  `;

  const slashEl = root.querySelector('#cc-slash');
  const attachEl = root.querySelector('#cc-attachments');
  const recBarEl = root.querySelector('#cc-rec-bar');
  const recTimerEl = root.querySelector('#cc-rec-timer');
  const recCanvasEl = root.querySelector('#cc-rec-canvas');
  const recCtrlsEl = root.querySelector('#cc-rec-ctrls');
  const recCancelBtn = root.querySelector('#cc-rec-cancel');
  const recDoneBtn = root.querySelector('#cc-rec-done');
  const recTranscribingEl = root.querySelector('#cc-rec-transcribing');
  const textarea = root.querySelector('#cc-textarea');
  const plusBtn = root.querySelector('#cc-plus');
  const chipsEl = root.querySelector('#cc-chips');
  const micBtn = root.querySelector('#cc-mic');
  const sendBtn = root.querySelector('#cc-send');

  // ---------- inputs de fichero ocultos ----------

  const fileCamera = document.createElement('input');
  fileCamera.type = 'file';
  fileCamera.accept = 'image/*';
  fileCamera.capture = 'environment';
  fileCamera.hidden = true;

  const filePhotos = document.createElement('input');
  filePhotos.type = 'file';
  filePhotos.accept = 'image/*,video/*';
  filePhotos.multiple = true;
  filePhotos.hidden = true;

  const fileAny = document.createElement('input');
  fileAny.type = 'file';
  fileAny.multiple = true;
  fileAny.hidden = true;

  root.appendChild(fileCamera);
  root.appendChild(filePhotos);
  root.appendChild(fileAny);

  for (const input of [fileCamera, filePhotos, fileAny]) {
    input.addEventListener('change', () => {
      handleFilesSelected(input.files);
      input.value = '';
    });
  }

  function handleFilesSelected(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (pending.length >= MAX_ATTACHMENTS) {
        toast(`Máximo ${MAX_ATTACHMENTS} adjuntos`, { type: 'error' });
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast(`"${file.name}" supera 30 MB`, { type: 'error' });
        continue;
      }
      const isImage = file.type.startsWith('image/');
      pending.push({
        id: `att-${attId++}`,
        file,
        previewUrl: isImage ? URL.createObjectURL(file) : null,
        status: 'pending',
      });
    }
    renderAttachments();
    renderSendState();
  }

  function removeAttachment(id) {
    const idx = pending.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const [item] = pending.splice(idx, 1);
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    renderAttachments();
    renderSendState();
  }

  function renderAttachments() {
    attachEl.innerHTML = '';
    attachEl.hidden = pending.length === 0;
    for (const item of pending) {
      const thumb = document.createElement('div');
      thumb.className = 'ccomposer__thumb';
      if (item.status === 'uploading') thumb.dataset.uploading = 'true';
      if (item.previewUrl) {
        const img = document.createElement('img');
        img.src = item.previewUrl;
        img.alt = item.file.name;
        thumb.appendChild(img);
      } else {
        thumb.classList.add('ccomposer__thumb--file');
        const iconSpan = document.createElement('span');
        iconSpan.innerHTML = icon('file');
        thumb.appendChild(iconSpan);
        const name = document.createElement('span');
        name.className = 'ccomposer__thumb-name';
        name.textContent = truncateName(item.file.name);
        thumb.appendChild(name);
      }
      if (item.status !== 'uploading') {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'ccomposer__thumb-remove';
        rm.innerHTML = icon('close');
        rm.setAttribute('aria-label', 'Quitar adjunto');
        rm.addEventListener('click', (ev) => {
          ev.stopPropagation();
          removeAttachment(item.id);
        });
        thumb.appendChild(rm);
      }
      attachEl.appendChild(thumb);
    }
  }

  function openAttachSheet() {
    sheets.open('Adjuntar', (body, close) => {
      const list = document.createElement('div');
      list.className = 'option-list';
      const rows = [
        ['camera', 'Cámara', () => fileCamera.click()],
        ['photo', 'Fotos', () => filePhotos.click()],
        ['file', 'Archivos', () => fileAny.click()],
      ];
      for (const [iconName, label, action] of rows) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'option-row';
        row.innerHTML = `${icon(iconName)}<span class="option-row__label">${label}</span>`;
        row.addEventListener('click', () => {
          close();
          action();
        });
        list.appendChild(row);
      }
      body.appendChild(list);
    });
  }

  plusBtn.addEventListener('click', openAttachSheet);

  // ---------- textarea auto-grow ----------

  const lineHeight = () => {
    const cs = window.getComputedStyle(textarea);
    return Number.parseFloat(cs.lineHeight) || 20;
  };

  function autoGrow() {
    textarea.style.height = 'auto';
    const maxHeight = lineHeight() * MAX_LINES + 2;
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
  }

  textarea.addEventListener('input', () => {
    autoGrow();
    renderSendState();
    renderSlash();
  });
  // Enter siempre inserta salto de línea (móvil): se envía solo con el botón. La única
  // excepción es el menú "/" abierto, donde Enter elige el comando resaltado (ver keydown).

  // ---------- enviar / detener ----------

  function hasText() {
    return textarea.value.trim() !== '';
  }
  function hasAttachments() {
    return pending.length > 0;
  }
  function computeMode() {
    // Con turno en curso el botón es Detener; en cuanto hay algo que enviar (texto o adjuntos)
    // vuelve a ser Enviar (el envío se encola en el cliente hasta que el turno termine).
    const busy = runningState === 'running' || runningState === 'starting';
    if (busy && !hasText() && !hasAttachments()) return 'stop';
    return 'send';
  }

  function renderSendState() {
    const mode = computeMode();
    sendBtn.dataset.mode = mode;
    sendBtn.innerHTML = icon(mode === 'stop' ? 'stop' : 'send');
    sendBtn.setAttribute('aria-label', mode === 'stop' ? 'Detener' : 'Enviar');
    if (mode === 'stop') {
      sendBtn.disabled = false;
    } else {
      sendBtn.disabled = uploading || !(hasText() || hasAttachments());
    }
  }

  // doSend es async (espera a que el dictado vuelque su último fragmento): un segundo toque
  // en Enviar durante esa espera no debe mandar el mismo texto dos veces.
  let sending = false;

  async function doSend() {
    if (sending) return;
    sending = true;
    try {
      await doSendInner();
    } finally {
      sending = false;
    }
  }

  async function doSendInner() {
    if (mediaRecorder || mediaStream) {
      try {
        await stopGeminiRecording(false);
      } catch {}
    }
    if (listening) {
      try {
        stopDictation('send');
      } catch {}
    }
    const text = textarea.value;
    if (!text.trim() && pending.length === 0) return;

    let attachmentNames = [];
    if (pending.length > 0) {
      const cid = chatId ? chatId() : null;
      if (!cid) {
        toast('No hay ningún chat abierto', { type: 'error' });
        return;
      }
      uploading = true;
      for (const item of pending) item.status = 'uploading';
      renderAttachments();
      renderSendState();
      try {
        for (const item of pending) {
          const res = await api(`/chats/${encodeURIComponent(cid)}/uploads?name=${encodeURIComponent(item.file.name)}`, {
            method: 'PUT',
            body: item.file,
            headers: { 'Content-Type': item.file.type || 'application/octet-stream' },
          });
          attachmentNames.push(res && res.name ? res.name : item.file.name);
        }
      } catch (err) {
        uploading = false;
        for (const item of pending) item.status = 'pending';
        renderAttachments();
        renderSendState();
        toast(`No se pudo subir el adjunto: ${err.message}`, { type: 'error' });
        return;
      }
      uploading = false;
    }

    onSend(text, attachmentNames);

    for (const item of pending) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    pending = [];
    renderAttachments();
    textarea.value = '';
    autoGrow();
    renderSendState();
  }

  sendBtn.addEventListener('click', () => {
    if (computeMode() === 'stop') {
      onStop();
      return;
    }
    doSend();
  });

  // ---------- micrófono (dictado en directo con Gemini 3.5 Transcribe) ----------

  let hasGeminiKey = false;
  let dictEngine = 'gemini';

  function updateDictEngineUI() {
    micBtn.classList.remove('ccomposer__mic--unsupported');
    micBtn.innerHTML = icon('mic');
  }

  // Comprobar si el backend tiene GEMINI_API_KEY configurada
  api('/config').then((c) => {
    hasGeminiKey = Boolean(c && c.hasGeminiKey);
    dictEngine = hasGeminiKey ? 'gemini' : (supportsSpeech() ? 'web' : 'gemini');
    updateDictEngineUI();
  }).catch(() => {
    updateDictEngineUI();
  });

  let recognition = null;
  let listening = false; // el usuario quiere dictar (hasta que vuelva a pulsar el botón)
  let dictBase = ''; // texto del textarea previo a la sesión de reconocimiento actual
  let dictHadResult = false; // ¿la sesión actual produjo algún resultado?
  let dictIdleRestarts = 0; // sesiones seguidas terminadas sin ningún resultado
  let dictStartedAt = 0;
  let dictStats = null; // telemetría (se envía al detener): eventos, sesiones, errores
  const DICT_MAX_IDLE_RESTARTS = 2;

  function joinDictation(base, spoken) {
    const s = String(spoken || '').replace(/\s+/g, ' ').trim();
    if (!s) return base;
    if (!base) return s;
    return /\s$/.test(base) ? base + s : `${base} ${s}`;
  }

  function releaseRecognition() {
    if (!recognition) return;
    const rec = recognition;
    recognition = null;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      rec.stop();
    } catch {
      // ya detenido
    }
  }

  function stopDictation(reason = 'user') {
    releaseRecognition();
    listening = false;
    micBtn.dataset.active = 'false';
    micBtn.setAttribute('aria-pressed', 'false');
    textarea.value = cleanSpeechText(textarea.value, dictLang);
    autoGrow();
    renderSendState();
    if (dictStats) {
      const s = dictStats;
      dictStats = null;
      post({
        type: 'dictation',
        message: `fin (${reason})`,
        ms: performance.now() - s.t0,
        extra: { sessions: s.sessions, results: s.results, finals: s.finals, maxResults: s.maxResults, errors: s.errors, chars: textarea.value.length },
      });
    }
  }

  function startRecognitionSession() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = dictLang;
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;

    dictBase = textarea.value;
    dictHadResult = false;
    dictStartedAt = performance.now();
    if (dictStats) dictStats.sessions += 1;

    rec.onresult = (ev) => {
      if (rec !== recognition) return;
      let spoken = '';
      let finals = 0;
      for (let i = 0; i < ev.results.length; i++) {
        const res = ev.results[i];
        const alt = res && res[0];
        if (!alt || !alt.transcript) continue;
        spoken += `${alt.transcript} `;
        if (res.isFinal) finals += 1;
      }
      dictHadResult = true;
      dictIdleRestarts = 0;
      if (dictStats) {
        dictStats.results += 1;
        dictStats.finals = Math.max(dictStats.finals, finals);
        dictStats.maxResults = Math.max(dictStats.maxResults, ev.results.length);
      }
      const cleaned = cleanSpeechText(spoken, dictLang);
      textarea.value = joinDictation(dictBase, cleaned);
      autoGrow();
      renderSendState();
    };
    rec.onerror = (ev) => {
      if (rec !== recognition) return;
      if (dictStats) dictStats.errors.push(ev.error || '?');
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        toast('Permite el micrófono en Ajustes › Safari', { type: 'error' });
        stopDictation(`error:${ev.error}`);
        return;
      }
      if (ev.error === 'no-speech' || ev.error === 'aborted' || ev.error === 'network') {
        // Safari corta por silencio con `no-speech`; lo tratamos como fin de sesión y
        // dejamos que `onend` decida si se reabre.
        return;
      }
      toast('No se pudo usar el dictado', { type: 'error' });
      stopDictation(`error:${ev.error}`);
    };
    rec.onend = () => {
      if (rec !== recognition) return;
      recognition = null;
      textarea.value = cleanSpeechText(textarea.value, dictLang);
      autoGrow();
      renderSendState();
      if (!listening) return;
      // Sesión cerrada por el navegador (silencio, límite interno…) sin que el usuario
      // haya pulsado: consolidamos el texto y reabrimos, salvo que lleve varias sesiones
      // seguidas sin reconocer nada (micrófono sin entrada, error silencioso, etc.).
      if (!dictHadResult) dictIdleRestarts += 1;
      const tooShort = performance.now() - dictStartedAt < 250 && !dictHadResult;
      if (dictIdleRestarts > DICT_MAX_IDLE_RESTARTS || tooShort) {
        stopDictation(tooShort ? 'end-inmediato' : 'sin-voz');
        return;
      }
      setTimeout(() => {
        if (listening && !recognition) startRecognitionSession();
      }, 120);
    };

    recognition = rec;
    try {
      rec.start();
    } catch (err) {
      if (dictStats) dictStats.errors.push(`start:${err && err.name}`);
      recognition = null;
      stopDictation('start-fallo');
    }
  }

  function startDictation() {
    dictIdleRestarts = 0;
    dictStats = { t0: performance.now(), sessions: 0, results: 0, finals: 0, maxResults: 0, errors: [] };
    listening = true;
    micBtn.dataset.active = 'true';
    micBtn.setAttribute('aria-pressed', 'true');
    startRecognitionSession();
  }

  // Si el usuario edita a mano mientras dicta, la próxima sesión debe partir del texto
  // editado; el `dictBase` se recalcula al reabrir sesión, y aquí paramos la actual para que
  // el interim no pise lo escrito.
  textarea.addEventListener('beforeinput', () => {
    if (listening && recognition) {
      releaseRecognition(); // onend no se disparará (handlers anulados): reabrimos nosotros
      setTimeout(() => {
        if (listening && !recognition) startRecognitionSession();
      }, 150);
    }
  });

  // ---------- visualizador y grabación para Gemini 3.5 Transcribe ----------

  let mediaRecorder = null;
  let audioChunks = [];
  let mediaStream = null;
  let isTranscribing = false;
  let audioCtx = null;
  let analyserNode = null;
  let animId = null;
  let recSeconds = 0;
  let recTimerInterval = null;

  function formatRecTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

function downsampleAndConvertToInt16(buffer, inputSampleRate, outputSampleRate = 16000) {
  if (inputSampleRate === outputSampleRate) {
    const pcm = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      const s = Math.max(-1, Math.min(1, buffer[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm.buffer;
  }
  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Int16Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    const sample = count > 0 ? accum / count : 0;
    const s = Math.max(-1, Math.min(1, sample));
    result[offsetResult] = s < 0 ? s * 0x8000 : s * 0x7fff;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result.buffer;
}

  let liveWs = null;
  let scriptProcessor = null;
  let baseTextBeforeRecord = '';
  let hasLiveTranscription = false;

  function startAudioVisualizer(stream) {
    stopAudioVisualizer();
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
      const source = audioCtx.createMediaStreamSource(stream);
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 64; // 32 bins de frecuencia
      analyserNode.smoothingTimeConstant = 0.78;
      source.connect(analyserNode);

      // Si tenemos WebSocket en directo, conectar ScriptProcessor para streaming de audio PCM 16kHz
      if (liveWs) {
        scriptProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
        source.connect(scriptProcessor);
        scriptProcessor.connect(audioCtx.destination);
        scriptProcessor.onaudioprocess = (e) => {
          if (!listening) return;
          const float32 = e.inputBuffer.getChannelData(0);
          const pcmBuf = downsampleAndConvertToInt16(float32, audioCtx.sampleRate, 16000);
          if (liveWs && liveWs.readyState === WebSocket.OPEN) {
            liveWs.send(pcmBuf);
          }
        };
      }

      const ctx = recCanvasEl.getContext('2d');
      const bufferLength = analyserNode.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      function renderFrame() {
        animId = requestAnimationFrame(renderFrame);
        if (!recCanvasEl || !analyserNode) return;

        const dpr = window.devicePixelRatio || 1;
        const rect = recCanvasEl.getBoundingClientRect();
        const targetW = Math.floor(rect.width * dpr);
        const targetH = Math.floor(rect.height * dpr);

        if (targetW > 0 && targetH > 0) {
          if (recCanvasEl.width !== targetW) recCanvasEl.width = targetW;
          if (recCanvasEl.height !== targetH) recCanvasEl.height = targetH;
        }

        const w = recCanvasEl.width;
        const h = recCanvasEl.height;
        if (!w || !h) return;

        analyserNode.getByteFrequencyData(dataArray);
        ctx.clearRect(0, 0, w, h);

        const hasSignal = dataArray.some((v) => v > 8);
        const timeNow = performance.now();

        // Renderizar barras de frecuencia reactivas (estilo ecualizador moderno)
        const barCount = Math.max(16, Math.min(32, Math.floor(w / (9 * dpr))));
        const step = Math.max(1, Math.floor(bufferLength / barCount));
        const totalBarWidth = w / barCount;
        const barWidth = Math.max(3.5 * dpr, totalBarWidth * 0.52);

        for (let i = 0; i < barCount; i++) {
          const sampleIdx = Math.min(bufferLength - 1, i * step);
          const rawVal = dataArray[sampleIdx] || 0;
          let norm = rawVal / 255;

          // Si hay silencio, mostrar una suave onda "respiratoria" viva
          if (!hasSignal) {
            const idle = Math.sin(timeNow * 0.005 + i * 0.35) * 0.5 + 0.5;
            norm = 0.06 + idle * 0.16;
          }

          const minH = 4 * dpr;
          const maxH = h * 0.88;
          const barH = Math.max(minH, Math.min(maxH, minH + norm * (maxH - minH)));

          const x = i * totalBarWidth + (totalBarWidth - barWidth) / 2;
          const y = (h - barH) / 2;

          // Degradado vertical dinámico: violeta a cian
          const grad = ctx.createLinearGradient(0, y, 0, y + barH);
          grad.addColorStop(0, '#c084fc');
          grad.addColorStop(0.5, '#818cf8');
          grad.addColorStop(1, '#38bdf8');

          ctx.fillStyle = grad;
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(x, y, barWidth, barH, barWidth / 2);
          } else {
            ctx.rect(x, y, barWidth, barH);
          }
          ctx.fill();
        }
      }
      renderFrame();
    } catch {
      // Continuar sin visualizador si AudioContext falla
    }
  }

  function stopAudioVisualizer() {
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
    if (scriptProcessor) {
      try { scriptProcessor.disconnect(); } catch {}
      scriptProcessor = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    analyserNode = null;
  }

  function getMediaRecorderMime() {
    if (typeof MediaRecorder === 'undefined') return '';
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4',
      'audio/aac',
      'audio/ogg;codecs=opus',
      'audio/wav',
    ];
    for (const c of candidates) {
      if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  async function startGeminiRecording() {
    if (isTranscribing) return;
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    try {
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    } catch {
      // ignore
    }

    if (!window.isSecureContext) {
      toast('El micrófono requiere conexión segura (HTTPS). Accede a través de tu URL HTTPS de Tailscale', { type: 'error', duration: 7000 });
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Este navegador no soporta grabación directa de audio en esta vista', { type: 'error', duration: 6000 });
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const isDenied = err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
      if (isDenied) {
        toast('Micrófono denegado: toca "aA" en la barra de URL de Safari -> Configuración del sitio web -> Micrófono: Permitir', { type: 'error', duration: 8000 });
      } else {
        toast(`Error al acceder al micrófono (${err ? err.name : 'desconocido'})`, { type: 'error', duration: 5000 });
      }
      return;
    }

    hasLiveTranscription = false;
    baseTextBeforeRecord = textarea.value;

    // Iniciar WebSocket para streaming en directo con Gemini 3.5 Transcribe Live
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let tokParam = '';
      try {
        const tok = localStorage.getItem('agyrc.token');
        if (tok) tokParam = `?token=${encodeURIComponent(tok)}`;
      } catch {}
      liveWs = new WebSocket(`${proto}//${location.host}/ws/transcribe${tokParam}`);
      liveWs.binaryType = 'arraybuffer';

      liveWs.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'interim' && msg.text) {
            hasLiveTranscription = true;
            textarea.value = baseTextBeforeRecord
              ? baseTextBeforeRecord + ' ' + msg.text
              : msg.text;
            autoGrow();
            renderSendState();
          } else if (msg.type === 'final' && msg.text) {
            hasLiveTranscription = true;
            baseTextBeforeRecord = cleanSpeechText(
              joinDictation(baseTextBeforeRecord, msg.text),
              'es-ES'
            );
            textarea.value = baseTextBeforeRecord;
            autoGrow();
            renderSendState();
          }
        } catch {}
      };
    } catch {
      liveWs = null;
    }

    audioChunks = [];
    const mimeType = getMediaRecorderMime();
    const options = mimeType ? { mimeType } : undefined;
    try {
      mediaRecorder = new MediaRecorder(mediaStream, options);
    } catch {
      mediaRecorder = new MediaRecorder(mediaStream);
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.start(250);
    listening = true;
    micBtn.dataset.active = 'true';
    micBtn.setAttribute('aria-pressed', 'true');

    // Mostrar barra con frecuencia en tiempo real y temporizador
    recSeconds = 0;
    recTimerEl.textContent = '0:00';
    clearInterval(recTimerInterval);
    recTimerInterval = setInterval(() => {
      recSeconds += 1;
      recTimerEl.textContent = formatRecTime(recSeconds);
    }, 1000);

    recBarEl.hidden = false;
    recCtrlsEl.hidden = false;
    recTranscribingEl.hidden = true;
    startAudioVisualizer(mediaStream);
  }

  async function stopGeminiRecording(cancelled = false) {
    clearInterval(recTimerInterval);
    recTimerInterval = null;

    if (liveWs) {
      try {
        if (!cancelled && liveWs.readyState === WebSocket.OPEN) {
          liveWs.send(JSON.stringify({ type: 'end' }));
        }
        liveWs.close();
      } catch {}
      liveWs = null;
    }

    stopAudioVisualizer();

    if (!mediaRecorder && !listening) return;
    const mr = mediaRecorder;
    mediaRecorder = null;
    listening = false;
    micBtn.dataset.active = 'false';
    micBtn.setAttribute('aria-pressed', 'false');

    const stopped = mr ? new Promise((resolve) => { mr.onstop = resolve; }) : Promise.resolve();
    try {
      if (mr && mr.state !== 'inactive') mr.stop();
    } catch {
      // ignore
    }
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) track.stop();
      mediaStream = null;
    }
    await stopped;

    if (cancelled) {
      audioChunks = [];
      textarea.value = baseTextBeforeRecord;
      autoGrow();
      renderSendState();
      recBarEl.hidden = true;
      return;
    }

    // Si la transcripción en directo ya completó el texto, aplicamos el limpiador final directamente
    if (hasLiveTranscription && textarea.value.trim()) {
      textarea.value = cleanSpeechText(textarea.value, 'es-ES');
      autoGrow();
      renderSendState();
      recBarEl.hidden = true;
      return;
    }

    if (!audioChunks.length) {
      recBarEl.hidden = true;
      return;
    }

    const mime = (mr && mr.mimeType) || 'audio/webm';
    const blob = new Blob(audioChunks, { type: mime });
    audioChunks = [];

    if (blob.size < 500) {
      recBarEl.hidden = true;
      return;
    }

    isTranscribing = true;
    recCtrlsEl.hidden = true;
    recTranscribingEl.hidden = false;
    micBtn.disabled = true;
    micBtn.innerHTML = icon('spark');
    micBtn.classList.add('ccomposer__mic--transcribing');

    try {
      const res = await api('/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': mime },
        body: blob,
      });
      if (res && res.text) {
        textarea.value = cleanSpeechText(joinDictation(baseTextBeforeRecord, res.text), 'es-ES');
        autoGrow();
        renderSendState();
      } else {
        toast('Gemini no detectó voz en el audio', { type: 'info' });
      }
    } catch (err) {
      toast(`Error Gemini Transcribe: ${err.message}`, { type: 'error' });
    } finally {
      isTranscribing = false;
      micBtn.disabled = false;
      micBtn.innerHTML = icon('mic');
      micBtn.classList.remove('ccomposer__mic--transcribing');
      recBarEl.hidden = true;
      recCtrlsEl.hidden = false;
      recTranscribingEl.hidden = true;
    }
  }

  recCancelBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    stopGeminiRecording(true);
  });

  recDoneBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    stopGeminiRecording(false);
  });

  micBtn.addEventListener('click', () => {
    if (dictEngine === 'gemini') {
      if (listening) {
        stopGeminiRecording(false);
      } else {
        startGeminiRecording();
      }
      return;
    }

    if (listening) {
      stopDictation();
      return;
    }
    if (!supportsSpeech()) {
      if (hasGeminiKey) {
        dictEngine = 'gemini';
        try { localStorage.setItem('agyrc.dictEngine', 'gemini'); } catch {}
        updateDictEngineUI();
        startGeminiRecording();
        return;
      }
      toast('Este navegador no soporta reconocimiento de voz nativo', { type: 'info', duration: 4000 });
      return;
    }
    startDictation();
  });

  // ---------- menú de comandos "/" ----------
  //
  // Al escribir "/" al principio del mensaje aparece la lista de comandos y se va filtrando con lo
  // que se teclea detrás (por comando, etiqueta o descripción, sin acentos). Dos familias:
  //  - Comandos de agy (GET /api/agy/commands, verificados en stream-json): los de tipo 'prompt'
  //    (/plan, /goal, skills…) se INSERTAN en el compositor ("/plan ") para que el usuario escriba
  //    el resto y envíe: agy los expande dentro del turno. Los de tipo 'cli' (/usage, /credits…)
  //    agy solo los responde como invocación propia, así que se ejecutan al elegirlos vía
  //    `onCommand` y su salida entra en el chat como mensaje de sistema.
  //  - Acciones de la app (modelo, esfuerzo, permisos, adjuntar, detener + las de `commands`).

  function fold(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function isBusy() {
    return runningState === 'running' || runningState === 'starting';
  }

  let agyCommands = []; // [{cmd, kind:'prompt'|'cli', desc, group?}]
  let agyCommandsPromise = null;
  function loadAgyCommands() {
    if (agyCommandsPromise) return agyCommandsPromise;
    agyCommandsPromise = api('/agy/commands')
      .then((r) => {
        agyCommands = r && Array.isArray(r.commands) ? r.commands : [];
        if (slashOpen) renderSlash();
        return agyCommands;
      })
      .catch(() => {
        agyCommandsPromise = null; // reintentar la próxima vez que se abra el menú
        return [];
      });
    return agyCommandsPromise;
  }

  function insertCommand(cmd) {
    textarea.value = `${cmd} `;
    autoGrow();
    renderSendState();
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function agyCommandItems() {
    return agyCommands.map((c) => {
      const name = c.cmd.slice(1);
      return {
        cmd: c.cmd,
        label: c.group === 'skill' ? `Skill · ${name}` : name.charAt(0).toUpperCase() + name.slice(1),
        desc: c.desc,
        icon: c.group === 'skill' ? 'spark' : c.kind === 'cli' ? 'terminal' : 'slash',
        group: 'agy',
        run: () => {
          if (c.kind === 'cli') {
            if (!onCommand) return;
            Promise.resolve(onCommand(c.cmd)).catch((err) => toast(`${c.cmd}: ${err.message}`, { type: 'error' }));
          } else {
            insertCommand(c.cmd);
          }
        },
      };
    });
  }

  function appCommandItems() {
    const list = [
      { cmd: '/modelo', alias: '/model', label: 'Cambiar modelo', desc: 'Elige el modelo de Antigravity', icon: 'diamond', run: () => openModelSheet() },
      { cmd: '/esfuerzo', alias: '/effort', label: 'Cambiar esfuerzo', desc: 'Bajo · Medio · Alto', icon: 'bolt', run: () => openEffortSheet() },
      { cmd: '/permisos', alias: '/mode', label: 'Permisos de edición', desc: 'Modo Normal · Plan · Aceptar ediciones y auto-aprobar', icon: 'mode', run: () => openPermissionsSheet() },
      {
        cmd: '/auto',
        label: chat && chat.autoApprove ? 'Desactivar auto-aprobar' : 'Activar auto-aprobar',
        desc: AUTOAPPROVE_DESC,
        icon: 'check',
        run: () => applyPatch({ autoApprove: !(chat && chat.autoApprove) }),
      },
      { cmd: '/adjuntar', alias: '/attach', label: 'Adjuntar', desc: 'Cámara, fotos o archivos', icon: 'plus', run: () => openAttachSheet() },
    ];
    if (isBusy()) {
      list.push({ cmd: '/detener', alias: '/stop', label: 'Detener', desc: 'Interrumpe el turno en curso', icon: 'stop', run: () => onStop() });
    }
    for (const c of extraCommands) {
      if (c && typeof c.cmd === 'string' && typeof c.run === 'function') list.push(c);
    }
    return list.map((c) => ({ ...c, group: 'app' }));
  }

  function slashCommands() {
    return [...agyCommandItems(), ...appCommandItems()];
  }

  let slashOpen = false;
  let slashItems = [];
  let slashIndex = 0;
  let slashDismissedFor = null; // valor del textarea con el que el usuario cerró el menú (Esc)

  function slashQuery() {
    const m = /^\/([^\s/]*)$/.exec(textarea.value);
    return m ? m[1] : null;
  }

  function closeSlash() {
    slashOpen = false;
    slashItems = [];
    slashEl.hidden = true;
    slashEl.innerHTML = '';
  }

  function renderSlash() {
    const q = slashQuery();
    if (q === null || slashDismissedFor === textarea.value) {
      if (q === null) slashDismissedFor = null;
      closeSlash();
      return;
    }
    loadAgyCommands();
    const fq = fold(q);
    const all = slashCommands();
    // Coincide por prefijo del comando o por inicio de palabra en etiqueta/descripción (un
    // "includes" a secas con 2 letras traía media lista).
    const wordStart = new RegExp(`(^|[^a-z0-9])${fq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    const items = fq
      ? all.filter((c) =>
          fold(c.cmd.slice(1)).startsWith(fq) ||
          (c.alias && fold(c.alias.slice(1)).startsWith(fq)) ||
          wordStart.test(fold(c.label)) ||
          wordStart.test(fold(c.desc))
        )
      : all;
    // Los que empiezan por el comando tecleado van primero (sort estable: se conserva el orden
    // agy → app dentro de cada bloque).
    if (fq) {
      items.sort((a, b) => {
        const aStarts = fold(a.cmd.slice(1)).startsWith(fq) || (a.alias && fold(a.alias.slice(1)).startsWith(fq));
        const bStarts = fold(b.cmd.slice(1)).startsWith(fq) || (b.alias && fold(b.alias.slice(1)).startsWith(fq));
        return Number(bStarts) - Number(aStarts);
      });
    }

    slashItems = items;
    slashIndex = Math.min(slashIndex, Math.max(0, items.length - 1));
    slashOpen = true;
    slashEl.hidden = false;
    slashEl.innerHTML = '';

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ccomposer__slash-empty';
      empty.textContent = 'Ningún comando coincide';
      slashEl.appendChild(empty);
      return;
    }
    items.forEach((c, i) => {
      // Cabecera de grupo cuando cambia (solo sin filtro, que con filtro se mezclan por prefijo)
      if (!fq && (i === 0 || items[i - 1].group !== c.group)) {
        const head = document.createElement('div');
        head.className = 'ccomposer__slash-group';
        head.textContent = c.group === 'agy' ? 'Antigravity' : 'App';
        slashEl.appendChild(head);
      }
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ccomposer__slash-item';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === slashIndex));
      if (i === slashIndex) row.dataset.active = 'true';
      row.innerHTML = `${icon(c.icon || 'slash')}<span class="ccomposer__slash-text"><span class="ccomposer__slash-label">${escapeHtml(c.label)}</span>${c.desc ? `<span class="ccomposer__slash-desc">${escapeHtml(c.desc)}</span>` : ''}</span><span class="ccomposer__slash-cmd">${escapeHtml(c.cmd)}</span>`;
      // pointerdown en vez de click: así el textarea no pierde el foco (y el teclado no baja)
      // antes de ejecutar la acción.
      row.addEventListener('pointerdown', (ev) => ev.preventDefault());
      row.addEventListener('click', () => runSlash(c));
      slashEl.appendChild(row);
    });
    const active = slashEl.querySelector('[data-active="true"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function runSlash(c) {
    closeSlash();
    slashDismissedFor = null;
    textarea.value = '';
    autoGrow();
    renderSendState();
    c.run();
  }

  textarea.addEventListener('keydown', (ev) => {
    if (!slashOpen) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (slashItems.length === 0) return;
      ev.preventDefault();
      const delta = ev.key === 'ArrowDown' ? 1 : -1;
      slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
      renderSlash();
    } else if (ev.key === 'Enter' || ev.key === 'Tab') {
      if (slashItems.length === 0) return;
      ev.preventDefault();
      runSlash(slashItems[slashIndex]);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      slashDismissedFor = textarea.value;
      closeSlash();
    }
  });

  // ---------- chips ----------

  function makeChip(id, iconName, initialLabel, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.id = id;
    btn.innerHTML = `${icon(iconName)}<span class="chip__label">${escapeHtml(initialLabel)}</span>`;
    btn.addEventListener('click', onClick);
    chipsEl.appendChild(btn);
    return btn;
  }

  const modelChip = makeChip('chat-chip-model', 'diamond', '—', () => openModelSheet());
  const effortChip = makeChip('chat-chip-effort', 'bolt', '—', () => openEffortSheet());
  const permChip = makeChip('chat-chip-perm', 'mode', '—', () => openPermissionsSheet());

  function setChipLabel(btn, text) {
    const span = btn.querySelector('.chip__label');
    if (span) span.textContent = text;
  }

  function renderChips() {
    setChipLabel(modelChip, chat && chat.model ? prettyModel(chat.model) : 'Modelo');
    setChipLabel(effortChip, chat && chat.effort ? EFFORT_LABEL[chat.effort] || chat.effort : 'Esfuerzo');
    const modeLabel = chat && chat.mode ? MODE_LABEL[chat.mode] || chat.mode : '—';
    setChipLabel(permChip, chat && chat.autoApprove ? `${modeLabel} · auto` : modeLabel);
  }

  async function applyPatch(patch) {
    try {
      await onPatch(patch);
      toast('Se aplicará en el próximo mensaje', { type: 'info' });
    } catch (err) {
      toast(`No se pudo aplicar el cambio: ${err.message}`, { type: 'error' });
    }
  }

  // ---------- modelo ----------

  const modelNames = new Map();
  function prettyModel(id) {
    return modelNames.get(id) || id;
  }

  function getModels() {
    if (modelsPromise) return modelsPromise;
    modelsPromise = api('/agy/models')
      .then((r) => (r && Array.isArray(r.models) ? r.models : []))
      .then((models) => {
        for (const m of models) modelNames.set(m.id, m.family || m.label || m.id);
        renderChips();
        return models;
      })
      .catch(() => {
        modelsPromise = null;
        return null;
      });
    return modelsPromise;
  }

  function openModelSheet() {
    sheets.open('Modelo', async (body, close) => {
      body.innerHTML = '<div class="sheet__loading">Cargando modelos…</div>';
      const models = await getModels();
      if (!models || models.length === 0) {
        body.innerHTML = '<p class="sheet__hint">No se pudo obtener la lista de modelos.</p>';
        return;
      }

      const families = new Map();
      for (const m of models) {
        if (!families.has(m.family)) families.set(m.family, []);
        families.get(m.family).push(m);
      }

      body.innerHTML = '';
      const list = document.createElement('div');
      list.className = 'option-list';

      for (const [family, variants] of families) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'option-row';
        const isCurrent = chat && (chat.model === family || variants.some((v) => v.id === chat.model));
        if (isCurrent) row.dataset.active = 'true';

        const label = document.createElement('span');
        label.className = 'option-row__label';
        label.textContent = family;
        row.appendChild(label);

        if (variants.length > 1) {
          const sub = document.createElement('span');
          sub.className = 'option-row__sub';
          sub.textContent = variants.map((v) => v.effort).filter(Boolean).join(' · ');
          row.appendChild(sub);
        }

        if (isCurrent) {
          const check = document.createElement('span');
          check.className = 'option-row__check';
          check.innerHTML = icon('check');
          row.appendChild(check);
        }

        row.addEventListener('click', () => {
          let chosen = variants[0];
          if (variants.length > 1) {
            const wantEffort = chat && chat.effort;
            chosen = variants.find((v) => v.effort === wantEffort) || variants[0];
          }
          close();
          try { localStorage.setItem('agyrc.lastModel', chosen.id); } catch {}
          applyPatch({ model: chosen.id });
        });

        list.appendChild(row);
      }

      body.appendChild(list);
    });
  }

  // ---------- esfuerzo ----------

  function openEffortSheet() {
    sheets.open('Esfuerzo', (body, close) => {
      const seg = document.createElement('div');
      seg.className = 'segmented';
      for (const [value, label] of [['low', 'Bajo'], ['medium', 'Medio'], ['high', 'Alto']]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'segmented__opt';
        btn.textContent = label;
        if (chat && chat.effort === value) btn.dataset.active = 'true';
        btn.addEventListener('click', async () => {
          close();
          try { localStorage.setItem('agyrc.lastEffort', value); } catch {}
          let newModel = undefined;
          if (chat && chat.model) {
            const models = await getModels();
            if (models) {
              const current = models.find((m) => m.id === chat.model);
              if (current) {
                const variant = models.find((m) => m.family === current.family && m.effort === value);
                if (variant) {
                  newModel = variant.id;
                  try { localStorage.setItem('agyrc.lastModel', variant.id); } catch {}
                }
              }
            }
          }
          applyPatch(newModel ? { effort: value, model: newModel } : { effort: value });
        });
        seg.appendChild(btn);
      }
      body.appendChild(seg);
    });
  }

  // ---------- permisos de edición (modo + auto-aprobar) ----------

  function openPermissionsSheet() {
    sheets.open('Permisos de edición', (body) => {
      const currentMode = chat ? chat.mode : 'normal';
      const list = document.createElement('div');
      list.className = 'option-list';

      for (const mode of MODE_ORDER) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'option-row option-row--stacked';
        if (currentMode === mode) row.dataset.active = 'true';

        const top = document.createElement('div');
        top.className = 'option-row__top';
        const label = document.createElement('span');
        label.className = 'option-row__label';
        label.textContent = MODE_LABEL[mode];
        top.appendChild(label);
        if (currentMode === mode) {
          const check = document.createElement('span');
          check.className = 'option-row__check';
          check.innerHTML = icon('check');
          top.appendChild(check);
        }
        row.appendChild(top);

        const desc = document.createElement('div');
        desc.className = 'option-row__desc';
        desc.textContent = MODE_DESC[mode];
        row.appendChild(desc);

        row.addEventListener('click', () => {
          sheets.close();
          if (mode !== currentMode) applyPatch({ mode });
        });

        list.appendChild(row);
      }

      body.appendChild(list);

      const toggleRow = document.createElement('div');
      toggleRow.className = 'field toggle-row ccomposer__perm-toggle';
      toggleRow.innerHTML = `
        <div class="toggle-row__text">
          <span>Auto-aprobar herramientas</span>
          <span class="toggle-row__desc">${AUTOAPPROVE_DESC}</span>
        </div>
        <button type="button" class="toggle" id="cc-autoapprove-toggle" role="switch"></button>
      `;
      body.appendChild(toggleRow);

      const toggleBtn = toggleRow.querySelector('#cc-autoapprove-toggle');
      const isOn = Boolean(chat && chat.autoApprove);
      toggleBtn.dataset.on = String(isOn);
      toggleBtn.setAttribute('aria-checked', String(isOn));
      toggleBtn.addEventListener('click', () => {
        const next = toggleBtn.dataset.on !== 'true';
        toggleBtn.dataset.on = String(next);
        toggleBtn.setAttribute('aria-checked', String(next));
        applyPatch({ autoApprove: next });
      });
    });
  }

  // ---------- estado público ----------

  function setChat(nextChat) {
    chat = nextChat;
    renderChips();
    setRunning(chat ? chat.state : 'idle');
  }

  function setRunning(state) {
    runningState = state;
    renderSendState();
    if (slashOpen) renderSlash(); // "/detener" solo aparece con turno en curso
  }

  getModels().catch(() => {}); // precarga nombres legibles de modelos
  loadAgyCommands(); // precarga el catálogo del menú "/" (skills incluidas)
  renderSendState();

  return {
    setChat,
    setRunning,
    composer: {
      getValue: () => textarea.value,
      setValue: (v) => {
        textarea.value = v;
        autoGrow();
        renderSendState();
        renderSlash();
      },
      clear: () => {
        textarea.value = '';
        autoGrow();
        renderSendState();
        closeSlash();
      },
      focus: () => textarea.focus(),
    },
  };
}

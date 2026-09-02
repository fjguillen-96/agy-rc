// server/transcribe.js
// Transcripción de audio con Gemini 3.5 Transcribe (Google AI Studio Interactions API).
// Soporta audio/webm, audio/mp4, audio/wav, audio/ogg con modo "smart" y vocabulario técnico.

import { config } from './config.js';

const CUSTOM_VOCABULARY = [
  'Antigravity', 'agy', 'Gemini', 'Gemini 3.8', 'Gemini 3.7', 'Gemini 3.1',
  'Claude', 'Sonnet', 'Opus', 'High', 'Medium', 'Low', 'Flash', 'Pro',
  'docker', 'Dockerfile', 'tmux', 'git', 'commit', 'pull request', 'branch', 'merge', 'push',
  'backend', 'frontend', 'endpoint', 'API', 'TypeScript', 'JavaScript', 'Python', 'Node.js', 'npm',
  'nueva sesión', 'agy-rc'
];

/**
 * @param {Buffer} audioBuffer
 * @param {string} mimeType
 * @returns {Promise<{ text: string }>}
 */
export async function transcribeAudioWithGemini(audioBuffer, mimeType = 'audio/webm') {
  if (!audioBuffer || audioBuffer.length === 0) {
    throw new Error('El buffer de audio está vacío');
  }

  if (!config.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY no está configurada en el servidor');
  }

  const cleanMime = mimeType.split(';')[0].trim() || 'audio/webm';
  const ext = cleanMime.includes('mp4') ? 'mp4' : cleanMime.includes('wav') ? 'wav' : cleanMime.includes('ogg') ? 'ogg' : 'webm';

  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).slice(2);
  const metadata = JSON.stringify({ file: { display_name: `speech.${ext}` } });

  const bodyParts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.${ext}"\r\nContent-Type: ${cleanMime}\r\n\r\n`,
  ];
  const prefix = Buffer.from(bodyParts[0] + bodyParts[1], 'utf8');
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const payload = Buffer.concat([prefix, audioBuffer, suffix]);

  // 1. Subir audio a Gemini Files API
  const uploadRes = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${config.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'multipart',
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: payload,
  });

  if (!uploadRes.ok) {
    const errBody = await uploadRes.text();
    throw new Error(`Error en Files API (${uploadRes.status}): ${errBody}`);
  }

  const uploadData = await uploadRes.json();
  const fileUri = uploadData.file && uploadData.file.uri;
  const fileName = uploadData.file && uploadData.file.name;
  if (!fileUri) throw new Error('No se recibió URI del archivo de audio');

  try {
    // 2. Invocar gemini-3.5-transcribe vía Interactions API
    const interactionRes = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: {
        'x-goog-api-key': config.GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gemini-3.5-transcribe',
        input: [
          {
            type: 'audio',
            uri: fileUri,
            mime_type: cleanMime,
          },
        ],
        generation_config: {
          transcription_config: {
            mode: 'smart',
            custom_vocabulary: CUSTOM_VOCABULARY,
          },
        },
      }),
    });

    if (!interactionRes.ok) {
      const errBody = await interactionRes.text();
      throw new Error(`Error en gemini-3.5-transcribe (${interactionRes.status}): ${errBody}`);
    }

    const result = await interactionRes.json();
    let text = result.output_text || '';
    if (!text && result.steps && Array.isArray(result.steps)) {
      for (const step of result.steps) {
        if (step.content && Array.isArray(step.content)) {
          for (const c of step.content) {
            if (c.type === 'text' && c.text) text += (text ? ' ' : '') + c.text;
          }
        }
      }
    }
    return { text: text.trim() };
  } finally {
    // 3. Eliminar archivo temporal en segundo plano
    if (fileName) {
      fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${config.GEMINI_API_KEY}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
  }
}

import { WebSocketServer, WebSocket } from 'ws';
import { wsAuth } from './auth.js';

/**
 * Servidor WebSocket para transcripción en directo (/ws/transcribe)
 * Enlaza el flujo de audio del cliente (PCM 16kHz) con gemini-3.5-transcribe-live.
 * @param {import('node:http').Server} httpServer
 */
export function attachTranscribeWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
      }
      return;
    }
    if (url.pathname !== '/ws/transcribe') return;
    // La auth se comprueba en 'connection' y se responde con close 4001: un navegador no puede
    // leer el status HTTP de un upgrade rechazado (vería 1006 y reconectaría a ciegas), pero sí
    // el código de cierre, con el que la PWA pide el token (public/js/socket.js).
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (clientWs, req) => {
    try {
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        clientWs.close(4001, 'unauthorized');
        return;
      }

      if (!wsAuth(url, req)) {
        clientWs.close(4001, 'unauthorized');
        return;
      }

    if (!config.GEMINI_API_KEY) {
      clientWs.send(JSON.stringify({ error: 'GEMINI_API_KEY no configurada' }));
      clientWs.close(1011, 'GEMINI_API_KEY no configurada');
      return;
    }

    const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${config.GEMINI_API_KEY}`;
    let geminiWs = null;
    let isReady = false;
    const pendingChunks = [];

    try {
      geminiWs = new WebSocket(GEMINI_WS_URL);
    } catch (err) {
      clientWs.send(JSON.stringify({ error: err.message }));
      clientWs.close();
      return;
    }

    geminiWs.on('open', () => {
      // Configurar sesión de Gemini 3.5 Transcribe Live
      const setupMessage = {
        setup: {
          model: 'models/gemini-3.5-transcribe-live',
          generationConfig: {
            responseModalities: ['TEXT'],
          },
          inputAudioTranscription: {
            languageCodes: [],
          },
        },
      };
      geminiWs.send(JSON.stringify(setupMessage));
    });

    geminiWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.setupComplete) {
          isReady = true;
          clientWs.send(JSON.stringify({ type: 'ready' }));
          while (pendingChunks.length > 0) {
            const chunk = pendingChunks.shift();
            sendPcmChunk(chunk);
          }
          return;
        }

        const sc = msg.serverContent;
        if (!sc) return;

        if (sc.interimInputTranscription && sc.interimInputTranscription.text) {
          clientWs.send(JSON.stringify({
            type: 'interim',
            text: sc.interimInputTranscription.text,
          }));
        }

        if (sc.inputTranscription && sc.inputTranscription.text) {
          clientWs.send(JSON.stringify({
            type: 'final',
            text: sc.inputTranscription.text,
          }));
        }
      } catch (err) {
        console.error('[transcribe-live] Error procesando respuesta de Gemini:', err);
      }
    });

    function sendPcmChunk(buf) {
      if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;
      geminiWs.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: buf.toString('base64'),
            mimeType: 'audio/pcm;rate=16000',
          },
        },
      }));
    }

    clientWs.on('message', (data, isBinary) => {
      if (isBinary || Buffer.isBuffer(data)) {
        const buf = Buffer.from(data);
        if (!isReady) {
          if (pendingChunks.length < 50) pendingChunks.push(buf);
        } else {
          sendPcmChunk(buf);
        }
        return;
      }

      try {
        const ctrl = JSON.parse(data.toString());
        if (ctrl.type === 'end' && geminiWs && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify({
            realtimeInput: {
              audioStreamEnd: true,
            },
          }));
        }
      } catch {}
    });

    const cleanup = () => {
      if (geminiWs) {
        try { geminiWs.close(); } catch {}
        geminiWs = null;
      }
    };

    clientWs.on('close', cleanup);
    clientWs.on('error', cleanup);
    geminiWs.on('close', () => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'closed' }));
        clientWs.close();
      }
    });
    geminiWs.on('error', (err) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ error: err.message }));
      }
      cleanup();
    });
    } catch (err) {
      console.error('[transcribe] Error initializing websocket connection:', err);
      try {
        clientWs.close(1011, 'internal error');
      } catch {}
    }
  });
}

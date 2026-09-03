# Modo chat (tipo Claude Code Remote Control) — contrato de diseño

> **El modo terminal se eliminó el 2026-09-02**: agy-rc es solo chat. Cada proceso agy del chat vive
> en una sesión tmux propia (§2.5) para sobrevivir a reinicios del servidor, pero ya no hay vista de
> terminal ni ruta para abrir la conversación en el TUI real de agy.

Objetivo: una experiencia de **chat nativo móvil** con Antigravity: burbujas de mensajes, texto en
streaming, tarjetas de herramientas, botón Detener real, cambio de modelo/esfuerzo/modo, nueva
conversación y reanudar conversaciones anteriores.

## 1. Protocolo de agy verificado (1.1.23/1.1.24, 2026-09-01)

Proceso de larga vida (uno por chat activo), cwd = carpeta del proyecto:
```
agy -p= --input-format stream-json --output-format stream-json --print-timeout 60m --add-dir <cwd> \
    [--model <id>] [--effort low|medium|high] [--mode plan|accept-edits] \
    [--dangerously-skip-permissions] [--conversation <uuid>] [--new-project]
```
- **Bug de workspace (corregido)**: agy 1.1.23 arranca con `cwd = <cwd>` y `init.cwd` lo reporta
  correctamente, PERO las herramientas (`run_command`, `view_file`…) corren en
  `~/.gemini/antigravity-cli/scratch` en vez de `<cwd>` salvo que se pase `--add-dir <cwd>`. Es la
  causa del bug reportado ("me dice que no está en ningún directorio"). Por eso `buildArgv()` añade
  SIEMPRE `--add-dir <cwd>`.
- **Entrada** (stdin, una línea NDJSON por turno; el proceso sigue vivo entre turnos y mantiene
  memoria): `{"event":"user","message":{"role":"user","content":"<texto>"}}`.
  Cualquier otro `event` se ignora con un warning en stderr. NO hay evento de cancelación.
- **Salida** (stdout NDJSON):
  - `{"event":"init","conversation_id":"<uuid>","init":{"cwd":"…","tools":[…],"permission_mode":"request-review"}}`
  - `{"event":"step_update","step_update":{"conversation_id","step_index":n,"state":"ACTIVE|DONE|ERROR","step_type":"user_input|agent_response|tool|unknown", ...}}`
    - `agent_response` ACTIVE trae `text_delta` (trozos de texto); el DONE final trae `text_delta` (a veces
      solo `"\n"`), `duration_seconds` y `usage:{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}`.
      Un `agent_response` DONE **sin ningún text_delta** = el modelo solo pensó (precede a una herramienta).
    - `tool` ACTIVE: `tool_name`, `tool_info:{name, parameters:{…}}` (p.ej. `run_command` → `{CommandLine}`,
      `list_dir` → `{DirectoryPath}`, `view_file`, `write_to_file`, `replace_file_content`, `grep_search`…).
      `tool` DONE: añade `tool_info.output` (string) y `duration_seconds`. `tool` ERROR: `tool_info.error:{type,message}`.
    - `unknown` DONE: pasos internos (p.ej. `ask_question`, que en headless se omite: el modelo recibe
      "el usuario omitió la pregunta"). Ignorar o mostrar como nota discreta.
  - `{"event":"result","result":{"conversation_id","status":"SUCCESS|ERROR","response":"<texto final>","error"?:"…","duration_seconds","num_turns","usage"}}` → fin de turno.
- **Permisos**: en headless NO se emiten peticiones; sin `--dangerously-skip-permissions` las herramientas
  que requieren permiso (run_command, escritura…) se **auto-deniegan** (`tool` ERROR "user denied permission"
  + aviso en stderr). Por eso el chat lanza por defecto con `--dangerously-skip-permissions` (`autoApprove:true`,
  el usuario ya lo usa así) y ofrece `--mode plan` como alternativa segura (solo lectura/planificación).
- **Cancelar**: SIGINT deja el proceso inservible (el siguiente turno sale con código 1). Detener =
  `kill` del proceso + marcar el mensaje como interrumpido; el siguiente envío **reanuda** con
  `--conversation <id>` (verificado: conserva el contexto; arranque ~1–2 s).
- **Cambiar modelo/esfuerzo/modo** = matar y relanzar con los nuevos flags + `--conversation <id>`.
- **Adjuntos (fotos/archivos)**: stream-json solo acepta bloques `text` (`content block type "image" is
  not supported`), pero agy lee imágenes y archivos con `view_file` por ruta (verificado: PNG 2×2 rojo →
  "Rojo"). Flujo: la app sube cada archivo con `PUT /uploads` → `data/uploads/<chat>/`; el runner
  pasa siempre esa carpeta como segundo `--add-dir` (la crea en `spawn()`), y el prompt que va a agy es
  `text + "\n\n[Archivos adjuntos por el usuario — rutas absolutas; usa view_file para verlos]\n- /abs/…"`
  (`composePrompt`). El mensaje de usuario persistido lleva `attachments:[{name,url,type,size}]` (el
  `type` se deduce de la extensión). `DELETE /chats/:id` borra también la carpeta de uploads.
- **Almacenamiento de agy**: `~/.gemini/antigravity-cli/brain/<conversation_id>/.system_generated/logs/transcript.jsonl`
  con pasos `{"step_index","source":"USER_EXPLICIT|MODEL","type":"USER_INPUT|PLANNER_RESPONSE|GENERIC","status","created_at","content"?, "thinking"?, "tool_calls"?:[{name,args}], "questions"?}`.
  `USER_INPUT.content` viene envuelto: `<USER_REQUEST>\n…\n</USER_REQUEST>` seguido de bloques `<ADDITIONAL_METADATA>`
  y `<USER_SETTINGS_CHANGE>` que hay que descartar. `PLANNER_RESPONSE.content` = texto del asistente (markdown);
  `GENERIC.content` = salida de herramienta. Historial de prompts: `~/.gemini/antigravity-cli/history.jsonl`
  (`{"display","timestamp","workspace","conversationId"?}`; el conversationId solo aparece en algunas líneas).
- `~/.gemini/antigravity-cli/presence/<conversation_id>.lock`: lock de conversación en uso.

## 2. Arquitectura

```
public/ (chat UI)  ⇄ WS /ws/chat?chat=<id>  ⇄ server/chat/ws-chat.js
                   ⇄ REST /api/chats…       ⇄ server/chat/routes.js
                                              ├─ server/chat/store.js   data/chats/<id>.json (meta) + <id>.ndjson (mensajes)
                                              ├─ server/chat/runner.js  ChatRunner: lanza agy stream-json, parseo, estado
                                              ├─ server/chat/tmux-proc.js  TmuxProcess: agy dentro de tmux (FIFO stdin, ficheros out/err)
                                              └─ server/chat/transcript.js  lee brain/…/transcript.jsonl + history.jsonl
```
Un chat = `{id, title, cwd, model, effort, mode:'normal'|'plan'|'accept-edits', autoApprove, newProject,
conversationId|null, createdAt, updatedAt, lastMessageAt, state:'idle'|'starting'|'running'|'stopped'}`.
El proceso agy se lanza al primer envío y se mata tras 15 min sin actividad (se relanza con
`--conversation` en el siguiente envío). Corre dentro de tmux (§2.5): si Node se reinicia, el turno
en curso sigue y el servidor lo re-adopta al arrancar.

### 2.1 Modelo de mensajes (persistido en `<id>.ndjson`, una línea por upsert; el último gana por `id`)
```ts
type Msg =
 | { id, ts, role:'user',      text, attachments?:[{name,url,type,size}] }
 | { id, ts, role:'assistant', text, done:boolean, thinking?:string, interrupted?:boolean, usage?, durationSeconds? }
 | { id, ts, role:'tool',      name, params:object, summary:string, output?:string, error?:string,
                               state:'active'|'done'|'error', durationSeconds? }
 | { id, ts, role:'system',    text, kind?:'info'|'error'|'stopped'|'turn'|'cli', cmd?:string }  // 'cli': salida de `agy --print=/cmd` (POST /chats/:id/command)
```
`summary` del tool: `run_command` → `CommandLine`; `view_file|write_to_file|replace_file_content|multi_replace_file_content|sed_file` → ruta (`AbsolutePath|TargetFile|FilePath`…: primer parámetro string que parezca ruta); `list_dir` → `DirectoryPath`; `grep_search|find_by_name` → `Query|Pattern|SearchDirectory`; `read_url_content|search_web` → `Url|query`; otros → primer valor string de `parameters` (máx 120 chars).
Mapeo de eventos: `agent_response` ACTIVE con `text_delta` → crea (si no existe para ese `step_index`) o
concatena en el mensaje assistant `a-<conv>-<step_index>`; DONE → `done:true` (+usage). `tool` → mensaje
`t-<conv>-<step_index>`. `result` → `state:'idle'`, y si `status==='ERROR'` un `system` kind `error`.
Al hacer Detener: assistant abierto → `interrupted:true, done:true` + system kind `stopped` "Detenido".
`output` de herramientas se guarda truncado a 20 KB.

`thinking` (razonamiento en texto plano): el stream-json de agy NO lo emite; se lee de
`brain/<conversation_id>/.system_generated/logs/transcript.jsonl` (mismo fichero que "reanudar
conversación anterior", ver más abajo) buscando la línea `PLANNER_RESPONSE` con ese `step_index`
(coincide con el `step_index` del `step_update` del stream). Puede tardar en escribirse tras el
`DONE` del stream: se reintenta hasta 3 veces (0 ms, 400 ms, 1500 ms) sin bloquear el resto del
NDJSON entrante. Si el `agent_response` DONE no tuvo ningún `text_delta` pero sí hay `thinking`,
se crea igualmente el mensaje assistant (paso "solo pensó"): `{ text:'', done:true, thinking }`.

`system` kind `'info'` (arranque del proceso, uno por cada `init` — también al relanzar/reanudar):
texto `Antigravity en <cwd> · auto-aprobar ON|OFF · <model|modelo por defecto> · <effort|por defecto>
[· modo plan|modo aceptar ediciones]`, id `sys-init-<Date.now()>`. Si el chat ya tenía
`conversationId` ANTES de este spawn (reanudación con `--conversation`), el texto empieza por
"Antigravity reanudado en …" en vez de "Antigravity en …".

### 2.2 REST (`server/chat/routes.js`, montado en `/api`)
| Método | Ruta | Body/Query | Respuesta |
|---|---|---|---|
| GET | `/api/chats` | — | `Chat[]` (sin mensajes) por `updatedAt` desc, cada uno con `lastMessage?:{role,text(≤140)}` |
| POST | `/api/chats` | `{title?, cwd, model?, effort?, mode?, autoApprove?=true, newProject?, conversationId?}` | 201 `Chat`. Si `conversationId`: importa el historial del transcript a `.ndjson` |
| GET | `/api/chats/:id` | `?limit=200` | `{chat, messages}` |
| PATCH | `/api/chats/:id` | `{title?, model?, effort?, mode?, autoApprove?}` | `Chat` (si el proceso corre y cambian flags → lo mata; se relanza al siguiente envío con `--conversation`) |
| DELETE | `/api/chats/:id` | — | 204 (mata proceso, borra meta+ndjson; NO borra la conversación de agy) |
| POST | `/api/chats/:id/send` | `{text, attachments?:string[]}` | 202 `{messageId}` (alternativa a WS; 409 si ya hay un turno en curso). `text` puede ir vacío si hay `attachments` (nombres devueltos por PUT uploads) |
| PUT | `/api/chats/:id/uploads` | `?name=<nombre>`; cuerpo = bytes del archivo (`Content-Type` del archivo; ≤ 30 MB) | 201 `{name, path, url, size, type}`. Guarda en `data/uploads/<id>/<name>` (nombre saneado; `-1`, `-2`… si ya existe). NO pasa por `express.json` |
| GET | `/api/chats/:id/uploads/:name` | — | el archivo (para miniaturas de la burbuja de usuario) |
| POST | `/api/chats/:id/command` | `{cmd}` (solo kind `cli` de `CHAT_COMMANDS`: `/usage`, `/credits`, `/skills`, `/agents`, `/changelog`) | 200 `{messageId, kind:'cli'|'error'}`; ejecuta `agy --print=/cmd` en el cwd del chat y emite un `system` por WS. 400 cmd no permitido, 404 chat |
| GET | `/api/agy/commands` | — | `{commands:[{cmd, kind:'prompt'|'cli', desc, group?:'skill'}]}` para el menú "/" |
| POST | `/api/chats/:id/stop` | — | 204 |
| GET | `/api/chats/:id/log` | `?limit=500` (1..5000) | `{entries}`: cola del registro crudo del CLI (`data/chats/<id>.log`, ver más abajo) |
| GET | `/api/agy/conversations` | `?limit=50` | `[{conversationId, title, workspace, lastAt, source:'history'|'brain'}]` desde history.jsonl (líneas con conversationId, dedupe, título = último `display` no vacío ni 'exit') ∪ carpetas de brain con transcript (título = primer USER_REQUEST), ordenadas por fecha desc |
Validación: `cwd` con `validateCwd` de sessions.js; `model` `^[\w.-]{1,64}$`; `effort` ∈ low/medium/high; `mode` ∈ normal/plan/accept-edits; `text` string 1..100000; `conversationId` uuid v4.

### Registro crudo del CLI (`data/chats/<id>.log`)
Cada entrada NDJSON: `{ts:number, src:'cmd'|'out'|'err'|'sys', line:string}`. `cmd`: el argv exacto
con el que se lanzó agy (shell-quote simple: comillas simples en los args con espacios o chars
fuera de `[\w@%+=:,./-]`) + ` # cwd=<cwd>`, registrado en cada `spawn()`. `out`: cada línea NDJSON
de stdout tal cual (parseada o no). `err`: cada línea de stderr. `sys`: eventos del runner —
`spawn pid=…`, `exit code=…`, `kill (detener)`, `idle-timeout`, `restart (flags cambiados)`. El
fichero se recorta a las últimas 2000 líneas cuando supera 4000. `GET /api/chats/:id/log` devuelve
las últimas `limit` entradas; por WS, ver `raw-sub`/`raw` en §2.3 (sin suscripción no se envían,
para ahorrar datos móviles).

### 2.3 WebSocket `/ws/chat?chat=<id>` (texto JSON en ambos sentidos)
- S→C al conectar: `{t:'hello', chat, state, messages:[…últimos 200]}`
- S→C: `{t:'msg', message}` (upsert por id; los deltas llegan como el mensaje completo actualizado, agrupando
  deltas en ≤ 1 envío cada 60 ms) · `{t:'state', state}` · `{t:'chat', chat}` (meta cambiada) · `{t:'error', message}` · `{t:'pong'}`
  · `{t:'raw', entries}` (solo mientras el ws está suscrito con `raw-sub`; agrupa entradas del
  registro crudo del CLI —ver §2.2— en ≤ 1 envío cada 100 ms)
- C→S: `{t:'send', text, attachments?:[names]}` · `{t:'stop'}` · `{t:'ping'}` · `{t:'raw-sub'}` / `{t:'raw-unsub'}`
  (suscripción por conexión al registro crudo; sin suscripción no se envían `raw`, para no gastar
  datos móviles en el uso normal del chat)
- Cierres: 4004 chat inexistente. Varios clientes por chat: broadcast.
- Mantener el heartbeat de `ws.js` (mismo `WebSocketServer` o uno propio con `path:'/ws/chat'`).

### 2.4 Frontend (chat)
- La pantalla principal (y única) es el chat; el drawer lista **Chats** (título, carpeta,
  modelo · esfuerzo, hace X, estado ●).
- Vista chat: topbar (☰ · título + carpeta · ⋯: renombrar, borrar chat) ·
  lista de mensajes con scroll propio (auto-scroll al fondo si el usuario está abajo; botón "↓" si no) ·
  burbujas: usuario (derecha, acento), asistente (izquierda, **markdown** renderizado con `marked` +
  `DOMPurify` servidos en `/vendor/marked/marked.umd.js` (global `marked`) y `/vendor/dompurify/purify.min.js` (global `DOMPurify`); código con
  scroll horizontal propio, nunca desborda), herramienta (tarjeta compacta: icono + nombre legible +
  `summary`; toca para desplegar `output`/`error` en monoespaciada con max-height y scroll; estado
  activo con spinner), sistema (línea centrada discreta). "Pensando…" (tres puntos) mientras hay un
  `agent_response` activo sin texto o el estado es `running` sin mensaje abierto.
- Dock (`chat-dock.js`, compositor propio estilo app móvil): tarjeta con adjuntos pendientes, textarea
  auto-grow (Enter = salto de línea) y fila **＋** (Cámara/Fotos/Archivos) · chips `Modelo` · `Esfuerzo` ·
  `Permisos de edición` (modo + auto-aprobar) · 🎤 dictado · **Enviar ⇄ Detener** (Detener mientras hay
  turno y el compositor está vacío; en cuanto se escribe vuelve a Enviar y el envío se encola en cliente
  hasta `idle`, con aviso "en cola"). "Nueva conversación" vive en el menú ⋯ de la topbar.
- Menú **"/"**: escribir `/` al principio (sin espacios detrás) abre dentro de la tarjeta la lista de
  comandos, filtrada en vivo por prefijo del comando o inicio de palabra en etiqueta/descripción (sin
  acentos); Enter/Tab o toque elige, Esc cierra. Dos grupos:
  - **Antigravity** (`GET /api/agy/commands`, catálogo `CHAT_COMMANDS` en `server/agy.js` + skills
    instaladas vía `agy --print=/skills`, caché 10 min). Verificado con agy 1.1.24 en stream-json:
    - kind `prompt` (`/plan`, `/goal`, `/grill-me`, `/browser`, `/boost`, `/teamwork-preview`, `/learn`,
      `/schedule` y cada skill `/nombre`): agy los expande dentro del turno → elegirlos **inserta**
      `"/plan "` en el compositor para escribir el resto y enviar como mensaje normal.
    - kind `cli` (`/usage`, `/credits`, `/skills`, `/agents`, `/changelog`): agy los rechaza por stdin
      ("answered by the CLI itself") → elegirlos hace `POST /api/chats/:id/command {cmd}`, que ejecuta
      `agy --print=/cmd` en el cwd del chat y añade un `system` kind `cli` (`{cmd, text}`, TSV → " · ",
      máx 20 KB; fallo → kind `error`). Se pinta como bloque monoespaciado con cabecera `/cmd`.
    - No se ofrecen los que abren paneles del TUI (agy los rechaza en modo print): `/context`, `/diff`,
      `/rewind`, `/resume`, `/fork`, `/rename`, `/clear`, `/btw`, `/codesearch`, `/config`, `/mcp`…;
      `/model` y `/effort` en print solo muestran el valor actual (ya lo hacen los chips).
  - **App**: `/modelo`, `/esfuerzo`, `/permisos`, `/auto`, `/adjuntar`, `/detener` (solo con turno en
    curso) y las externas que pasa `main.js` (`/nueva`, `/registro`). Ejecutan la acción y
    vacían el compositor.
- Dictado (`SpeechRecognition`, solo en contexto seguro → HTTPS de Tailscale): el texto de cada sesión
  se reconstruye desde `results[0]` (iOS Safari reenvía tramos ya vistos) y si Safari cierra la sesión
  por silencio se reabre sola sobre el texto consolidado; se apaga tras 3 sesiones sin voz, al enviar o
  al pulsar el botón. Envía un resumen a `/api/client-log` (`[client:dictation]`) para depurar en iOS.
- Nuevo chat (sheet): Proyecto (explorador + Nueva carpeta), Título (opcional; por defecto el primer
  mensaje), Modelo, Esfuerzo, Modo (Normal · Plan · Aceptar ediciones), toggle **Auto-aprobar herramientas**
  (ON por defecto, texto: "Antigravity ejecuta comandos y edita archivos sin preguntar. Desactívalo para
  modo Plan o si quieres revisar."), toggle Nuevo proyecto de Antigravity. Botón secundario **Reanudar
  conversación anterior…** → lista de `/api/agy/conversations` (título, carpeta, fecha) → crea chat con `conversationId`.
- Reconexión WS igual que ahora (backoff, visibilitychange). Al reconectar, `hello` reemplaza el estado.
- Idioma (`public/js/i18n.js`): la UI está en español e inglés. Las cadenas del código fuente están en
  español y son la clave (`t('Nuevo chat')`); el diccionario EN vive al final de `i18n.js`. Se detecta de
  `navigator.language`, se guarda en `localStorage['agyrc.lang']` y el botón del pie del drawer alterna
  y recarga la página. Los mensajes `system` del servidor llevan `key` + `params` (`sys.init`,
  `sys.stopped`, `sys.exit`…) y el cliente los traduce con `systemText()`; `text` sigue siendo el
  español para compatibilidad. Los comandos de agy llevan `desc` (es) y `descEn`. El manifest se sirve
  como `/manifest.json` (en) o `/manifest.es.json` (es) cambiando el `<link rel="manifest">`.

### 2.5 Proceso agy en tmux (`server/chat/tmux-proc.js`, `scripts/chat-agy.sh`)
El servidor no lanza agy con `child_process` sino en una sesión tmux `chat-<id>` del socket
`AGY_TMUX_SOCKET` (`tmux -L agyrc -f scripts/tmux.conf`, con `exit-empty off` / `destroy-unattached
off`), así el proceso sobrevive a reinicios de agy-rc y a cierres de la app. Dentro de la sesión corre
`scripts/chat-agy.sh <fifo> <out> <err> agy …`, que:
- ejecuta agy con stdin desde el FIFO `data/chats/<id>.in` (abierto `0<>`, lectura/escritura, para que
  nunca reciba EOF), stdout añadido a `<id>.out` y stderr a `<id>.err`;
- escribe en `<id>.out` marcadores propios `{"agyrc":"spawn","pid":N}` y `{"agyrc":"exit","code":N}`
  (cada uno precedido de `\n`); el runner los intercepta y no los trata como eventos de agy.

`TmuxProcess` imita la interfaz de un child process: `stdin.write(línea)` abre el FIFO en
`O_WRONLY|O_NONBLOCK` por cada línea (ENXIO = nadie lee → se reintenta mientras el proceso no haya
terminado; si terminó, error "Antigravity ya terminó"); `stdout`/`stderr` se emiten siguiendo
`<id>.out`/`<id>.err` por offset de bytes (fs.watch + sondeo cada 150 ms, solo hasta el último `\n`
completo); `kill()` manda la señal al pid del marcador (o `tmux kill-session`) y comprueba la sesión
1,5 s después; además `tmux has-session` cada 5 s como red de seguridad si el marcador exit no llega.

Persistencia: `chat.proc = {session, pid, outOffset, errOffset}` se guarda en `<id>.json` (con
throttle de 300 ms según avanza la salida) y se pone a `null` al terminar el proceso. Al arrancar,
`ChatManager.restoreAll()` (llamado en `server/index.js` tras `listen`) recorre los chats con `proc`
y hace `ChatRunner.attach()`: retoma la lectura desde los offsets guardados (lo que agy escribió
mientras el servidor no estaba se procesa igual), y si el chat estaba `running`/`starting` reabre en
memoria los mensajes de asistente con `done:false` para seguir acumulando deltas. Si agy murió en
ese intervalo, el marcador exit pendiente cierra el turno con un `system` kind `error`
("Antigravity terminó (código N)"). Después mata las sesiones `chat-*` de chats que ya no existen.
`DELETE /api/chats/:id` espera a que agy termine (marcador exit, máx. 2 s) antes de borrar
`<id>.in/.out/.err` junto al resto de ficheros del chat.

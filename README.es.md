# agy-rc — PWA Remota para Antigravity CLI

<p align="center">
  <a href="README.md">English</a> • <a href="README.es.md">Español</a>
</p>

**agy-rc** es una Progressive Web App (PWA) móvil autohospedada para chatear con el CLI **Antigravity** (`agy`) alojado en un servidor o Mini PC Linux a través de la red segura de **Tailscale**.

<p align="center">
  <img src="docs/screenshots/demo.gif" alt="Demo de agy-rc: un turno completo de Antigravity desde el móvil — comando, tarjetas de herramienta y respuesta en streaming" width="300" />
</p>

<p align="center">
  <img src="docs/screenshots/01-chat.png" alt="Chat con respuesta en streaming" width="19%" />
  <img src="docs/screenshots/02-tools.png" alt="Tarjetas de herramienta con salida desplegada" width="19%" />
  <img src="docs/screenshots/03-commands.png" alt="Menú de comandos /" width="19%" />
  <img src="docs/screenshots/04-drawer.png" alt="Drawer con la lista de chats" width="19%" />
  <img src="docs/screenshots/05-new-chat.png" alt="Hoja de nuevo chat con selector de carpeta" width="19%" />
</p>

> [!NOTE]
> **Solución provisional de la comunidad**: Este proyecto nace como una solución comunitaria de código abierto para disfrutar desde hoy de una experiencia remota táctil en el móvil con Google Antigravity, hasta que Google DeepMind lance de forma oficial su propio control remoto de Antigravity para dispositivos móviles.

> La interfaz está disponible en **español e inglés** (se detecta del navegador; se cambia desde el menú lateral).

Proporciona una interfaz de chat táctil cuidada, al estilo de Claude Code Remote Control: burbujas,
texto en streaming, tarjetas de herramientas, botones de acción rápida y selector visual de proyectos.
Incluye un icono PWA original diseñado para identificar la aplicación con estilo al instalarla en el móvil.

```
 Móvil (PWA)                         Mini PC (Linux, Tailscale 100.x.y.z)
┌─────────────────────┐   HTTPS/WSS   ┌──────────────────────────────────────────────┐
│ chat (burbujas)     │◄────────────►│ Node.js  server/index.js  (express + ws)     │
│ drawer de chats     │  REST /api   │   ├─ routes.js       health, dirs, agy       │
│ compositor + "/"    │  WS   /ws    │   ├─ chat/*          CRUD y streaming del chat│
│ service worker      │              │   └─ tmux.js         wrapper `tmux -L agyrc` │
└─────────────────────┘              │                 │                            │
                                     │   tmux server (socket agyrc, proceso aparte) │
                                     │   └─ procesos `agy` de los chats en marcha   │
                                     └──────────────────────────────────────────────┘
```

### Principio de resiliencia en 3 capas:
* **tmux (`-L agyrc`) posee los procesos `agy`:** Las tareas continúan ejecutándose en el servidor sin importar si el teléfono se bloquea, pierde cobertura o cambia entre redes WiFi y 4G.
* **Node.js actúa únicamente como orquestador:** Cada chat en marcha corre en una sesión tmux propia. Si el servidor Node se reinicia, la unidad systemd utiliza `KillMode=process` para garantizar que el servidor tmux y sus sesiones sigan vivos.
* **La PWA reconecta automáticamente:** Al reabrir el móvil, la PWA restablece la conexión WebSocket del chat de inmediato y recupera el historial y el estado exactos, sin duplicación ni pérdida.

---

## Requisitos del Sistema

* **Sistema Operativo:** Linux con `systemd` (Arch Linux / CachyOS, Ubuntu/Debian, Fedora, etc.).
* **Node.js:** Versión `>= 20.6` (probado y optimizado en Node 26 con soporte nativo de `--env-file-if-exists` y `--watch`).
* **tmux:** Versión `>= 3.1` (requerido por `window-size latest`, probado en tmux 3.7b).
* **CLI Antigravity (`agy`):** Instalado en `$HOME/.local/bin/agy` o accesible en el `PATH` del usuario ([antigravity.google](https://antigravity.google)).
* **Tailscale:** Conectado y operativo en el servidor (para acceso remoto seguro sin abrir puertos al router).

---

## Instalación Rápida

1. **Clonar o situar el repositorio** en tu servidor o Mini PC (por ejemplo en `~/projects/agy-rc`):
   ```bash
   git clone https://github.com/fjguillen-96/agy-rc.git ~/projects/agy-rc
   cd ~/projects/agy-rc
   ```

2. **Ejecutar el instalador automatizado:**
   ```bash
   ./scripts/install.sh
   ```

   El instalador interactivo:
* Verifica las dependencias del sistema (`node`, `npm`, `tmux`, `agy`, `tailscale`).
* Instala las dependencias de Node.js con `npm ci --omit=dev`.
* Crea el archivo `.env` a partir de `.env.example` (con token seguro generado por defecto; usa `--no-token` si prefieres acceso abierto) y configurando `AGY_PROJECTS_ROOT`.
* Crea el directorio `data/` para la persistencia de metadatos.
* Instala e inicia la unidad systemd de usuario (`~/.config/systemd/user/agy-rc.service`) con `KillMode=process`.
* Habilita `loginctl enable-linger` para que el servicio arranque tras reiniciar el Mini PC sin requerir un login interactivo.
* Realiza un health check en `http://127.0.0.1:8787/api/health` e imprime las URLs de acceso.

> **Nota:** Si prefieres instalar solo dependencias y entorno sin configurar el servicio systemd, ejecuta:
> ```bash
> ./scripts/install.sh --no-service
> ```

---

## HTTPS con Tailscale para Instalar la PWA

Los navegadores modernos (Google Chrome en Android, Safari en iOS) **exigen un contexto seguro (HTTPS con certificado válido)** para registrar el Service Worker y permitir instalar la aplicación en la pantalla de inicio como PWA nativa. Acceder directamente por `http://100.x.y.z:8787` no se considera un contexto seguro.

### 1. Activar HTTPS con Tailscale Serve (Recomendado)

Ejecuta en el servidor:
```bash
./scripts/tailscale-https.sh
```

El script configurará `tailscale serve` en segundo plano para reenviar el puerto 443 HTTPS a tu puerto local de agy-rc (8787) y te proporcionará tu URL pública de la tailnet (ejemplo: `https://tu-nodo.tailXXXXXX.ts.net`).

#### Requisitos en la consola web de Tailscale:
Si `tailscale-https.sh` muestra un aviso sobre certificados o DNS:
1. Accede a [login.tailscale.com/admin/dns](https://login.tailscale.com/admin/dns).
2. Habilita **MagicDNS**.
3. Habilita **HTTPS Certificates** (permite a Tailscale solicitar certificados TLS automáticos de Let's Encrypt para tus nodos).

> **Permisos de Tailscale:** Si recibes un error de permisos al ejecutar `tailscale serve`, concede privilegios de operador a tu usuario con:
> ```bash
> sudo tailscale set --operator=$USER
> ```

Para desactivar HTTPS en cualquier momento:
```bash
./scripts/tailscale-https.sh --off
```

> **Primera vez:** si el script dice *"Tailscale Serve no está habilitado en tu tailnet"*, abre el enlace
> `https://login.tailscale.com/f/serve?node=…` que imprime, acepta, y en **Admin → DNS** activa
> *MagicDNS* y *HTTPS Certificates*. Vuelve a ejecutar el script: la URL quedará como
> `https://tu-nodo.<tailnet>.ts.net`.

### 2. Alternativas sin HTTPS

* **Uso directo en el navegador:** Puedes abrir `http://<tailscale-ip>:8787` en el navegador del móvil. La interfaz y el WebSocket del chat funcionarán al 100%, aunque no aparecerá la opción de instalar como PWA standalone ni caché offline de assets.
* **Flag de desarrollo en Chrome:** En Chrome para Android, abre `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, añade `http://<tailscale-ip>:8787`, activa el flag y reinicia el navegador.

---

## Instalar la PWA en el Móvil

Una vez configurado HTTPS y con Tailscale conectado en tu teléfono:

### En Android (Google Chrome):
1. Abre `https://<tu-hostname>.<tu-tailnet>.ts.net` en Chrome.
2. Pulsa en el menú de opciones (tres puntos verticales) y selecciona **"Instalar aplicación"** o **"Añadir a la pantalla de inicio"** (o pulsa en el banner emergente inferior).

### En iOS (Safari):
1. Abre `https://<tu-hostname>.<tu-tailnet>.ts.net` en Safari.
2. Pulsa el botón **Compartir** (icono de cuadro con flecha hacia arriba).
3. Desplázate hacia abajo y selecciona **"Añadir a pantalla de inicio"**.

---

## Modo chat

> agy-rc es **solo chat**: no hay vista de terminal en la PWA. Los procesos de agy viven en tmux por
> debajo (ver `server/chat/runner.js`) para sobrevivir a reinicios del servidor, pero la interfaz es
> siempre la conversación.

La pantalla principal (y única) es un **chat nativo móvil** con Antigravity, al estilo de Claude Code
Remote Control: burbujas, texto en streaming, tarjetas de herramientas (comando ejecutado + salida
desplegable), "pensando…", botón **Detener** real, chips de **Modelo / Esfuerzo / Modo**, nueva
conversación y **reanudar conversaciones anteriores** de agy. Funciona sobre el protocolo
`--output-format stream-json` de agy (ver `docs/CHAT.md`), con un proceso `agy` persistente por
chat (se apaga tras 15 min sin uso y se reanuda por `conversation_id` al siguiente mensaje).

Límites del modo headless de agy que asume el chat:
* **Permisos**: agy no emite peticiones de permiso en este modo; por eso el chat lanza por defecto con
  *Auto-aprobar herramientas* (`--dangerously-skip-permissions`). Desactívalo y usa **Modo Plan** si
  quieres que solo lea y planifique.
* **Preguntas de elección** (`ask_question`) se omiten: el modelo pregunta en texto y respondes en el chat.
* **Detener** mata el proceso y reanuda la conversación en el siguiente mensaje (conserva el contexto).

El workspace de cada chat es siempre la carpeta que elegiste al crearlo (`--add-dir`), así que agy
lee y edita ahí y no en una carpeta de scratch interna. El razonamiento del modelo (thinking), cuando
lo hay, se muestra junto a la respuesta. Para depurar a fondo, "Registro de agy" enseña el NDJSON
crudo del proceso.

## Uso de la Aplicación

La interfaz está pensada como **Claude Code web**: la conversación con Antigravity arriba y, abajo, un
compositor de mensajes con controles semánticos. No hay que escribir comandos ni combinaciones de teclas.

* **Nuevo chat (`+`):** elige el proyecto (explorador de carpetas), el **modelo**, el **esfuerzo**
  (low / medium / high), el **modo** (Normal · Aceptar ediciones · Plan) y, opcionalmente, *Auto-aprobar
  permisos* o *Nuevo proyecto de Antigravity*. Se lanza `agy` con esos flags dentro de tmux.
* **Compositor:** escribe el mensaje (multilínea) y pulsa enviar. El botón `/` (o escribir `/`) abre la
  lista de comandos: los de la app (`/modelo`, `/esfuerzo`, `/permisos`, `/auto`, `/adjuntar`,
  `/detener`, `/nueva`, `/registro`) y los de agy que funcionan en modo headless (`/plan`, `/goal`,
  `/grill-me`, `/browser`, `/boost`, `/usage`, `/credits`, `/skills`, `/agents`, `/changelog`…; ver
  `server/agy.js`). Los comandos de agy que abren paneles del TUI (`/context`, `/diff`, `/resume`…)
  no están disponibles en el chat.
* **Chips de estado y control:** `Modelo`, `Esfuerzo` y `Modo` muestran el estado real del chat y, al
  tocarlos, lo cambian. **Detener** cancela el turno en curso.
* **Menú del chat (`⋯`):** Nueva conversación, Renombrar, Borrar chat, Razonamiento (plegado /
  desplegado / oculto), Registro de agy.
* **Drawer (`☰`):** lista de chats con proyecto, modelo · esfuerzo, modo y estado; cambia de chat
  al tocar. Los chats siguen vivos (en tmux) aunque cierres la app.

---

## Persistencia y Resiliencia

El diseño de agy-rc garantiza que **nunca pierdas trabajo**:

| Escenario | Qué ocurre | Cómo se recupera |
|---|---|---|
| **Móvil suspendido / pantalla apagada** | El WebSocket del chat se cierra para ahorrar batería. `agy` continúa trabajando en tmux. | Al desbloquear el móvil, el evento `visibilitychange` reconecta el WebSocket de inmediato y recupera el estado del chat. |
| **Cambio de red (WiFi ⇄ 4G / túnel)** | La conexión TCP se interrumpe temporalmente. | El socket reconecta con backoff exponencial. Al volver la cobertura (`online`), reconecta de inmediato. |
| **Reinicio del servicio Node.js** (`systemctl --user restart agy-rc`) | El proceso Node se detiene y arranca de nuevo. Gracias a `KillMode=process`, el servidor tmux hijo **NO muere**. | La PWA reconecta a los 2 segundos y recupera el chat activo. |
| **Reinicio completo del Mini PC** | Las sesiones en memoria de tmux se pierden tras el reinicio del sistema operativo. | El servicio arranca automáticamente gracias a `enable-linger`. Envía un mensaje en el chat para retomar la conversación con Antigravity en ese directorio. |

---

## Configuración (`.env`)

Las variables de configuración se gestionan mediante el archivo `.env` en la raíz del proyecto:

| Variable | Por Defecto | Descripción |
|---|---|---|
| `HOST` | `0.0.0.0` | Dirección IP de escucha del servidor HTTP/WebSocket. |
| `PORT` | `8787` | Puerto de escucha de la aplicación. |
| `AGY_TOKEN` | *(vacío)* | Token secreto de autenticación (Bearer token). Si está configurado, protege todas las rutas `/api/*` y `/ws`. |
| `AGY_CMD` | `agy` | Comando del CLI Antigravity a ejecutar (debe encontrarse en el PATH). |
| `AGY_PROJECTS_ROOT` | `$HOME/projects` | Carpeta inicial del selector de proyectos. Es solo el punto de partida: el selector puede navegar a cualquier ruta legible por el usuario que ejecuta agy-rc. |
| `AGY_TMUX_SOCKET` | `agyrc` | Nombre del socket dedicado de tmux (`tmux -L agyrc`), aislado de tus sesiones tmux de usuario. |
| `AGY_DATA_DIR` | `./data` | Directorio de datos persistentes (relativo a la raíz del repo). Los chats se guardan en `<AGY_DATA_DIR>/chats`. |
| `GEMINI_API_KEY` | *(vacío)* | Clave de API de Google Gemini (opcional) para la transcripción de voz en tiempo real con Gemini 3.5 Live. |

---

## 🎙️ Dictado por Voz en Tiempo Real (Gemini 3.5 Live)

`agy-rc` incluye una canalización de audio en streaming:
1. El micrófono captura el audio en el navegador a 16 kHz PCM mono.
2. Se transmite por WebSockets en tiempo real a la API de **Gemini 3.5 Live** (`models/gemini-3.5-transcribe-live`).
3. Un limpiador fonético técnico corrige términos de programación (Docker, Kubernetes, Gemini 3.8, etc.) y puntuación.

### Cómo obtener tu clave de Gemini API (100% Gratuita):
1. Entra en **[Google AI Studio](https://aistudio.google.com/)**.
2. Inicia sesión con cualquier cuenta de Google.
3. Haz clic en **"Get API key"** en la barra lateral izquierda.
4. Pulsa en **"Create API key"** y selecciona o crea un proyecto (se crea en 1 clic).
5. Copia tu clave (`AIzaSy...`) y añádela a tu `.env`:
   ```bash
   GEMINI_API_KEY=AIzaSy...
   ```
6. Reinicia el servicio para que surta efecto:
   ```bash
   systemctl --user restart agy-rc.service
   ```

> **Nivel gratuito:** Google AI Studio ofrece un nivel gratuito muy generoso para desarrolladores. No se requiere tarjeta de crédito.

---

## Operación y Mantenimiento

### Comandos de diagnóstico
* **Ver estado completo del sistema y sesiones:**
  ```bash
  ./scripts/status.sh
  ```
* **Seguir logs en tiempo real:**
  ```bash
  ./scripts/status.sh -f
  # O directamente con journalctl:
  journalctl --user -u agy-rc -f
  ```

### Gestión del servicio systemd
* **Reiniciar servicio:**
  ```bash
  systemctl --user restart agy-rc
  ```
* **Detener servicio:**
  ```bash
  systemctl --user stop agy-rc
  ```
* **Iniciar servicio:**
  ```bash
  systemctl --user start agy-rc
  ```

### Modo desarrollo
Para trabajar en el backend o frontend con recarga automática de Node.js:
```bash
./scripts/dev.sh
```

### Ejecución directa en primer plano (producción)
```bash
./scripts/start.sh
```

### Actualización de agy-rc
```bash
cd ~/projects/agy-rc
git pull
npm ci --omit=dev
systemctl --user restart agy-rc
```

### Desinstalación
Para detener y eliminar el servicio systemd de forma limpia:
```bash
./scripts/uninstall.sh
```

---

## Seguridad

1. **Aislamiento en red Tailscale:** agy-rc está pensado para utilizarse exclusivamente dentro de tu red privada (tailnet). No abras el puerto 8787 ni el puerto 443 a Internet público sin autenticación y cortafuegos.
2. **Autenticación por Token:** `AGY_TOKEN` utiliza comparación en tiempo constante (`crypto.timingSafeEqual`) tanto en peticiones REST (`Authorization: Bearer <token>` o `?token=`) como en el handshake de WebSockets para prevenir ataques de temporización.
3. **Alcance del sistema de archivos:** `AGY_PROJECTS_ROOT` es solo la carpeta inicial del selector; un usuario autenticado puede abrir chats en cualquier directorio al que tenga acceso el usuario del sistema que ejecuta agy-rc (y agy podrá leer y editar ahí). El `cwd` se valida (existe, es un directorio, sin `../` relativos), pero la frontera real es la cuenta de usuario y el token: quien tiene el token tiene el mismo poder que tú en esa máquina.
4. **Protección contra Inyección de Comandos:** Los argumentos que llegan a tmux se validan y escapan de forma estricta.

---

## Solución de Problemas (Troubleshooting)

### 1. Mensaje "no server running" en tmux
Es completamente normal si el servicio acaba de iniciar y aún no se ha creado ningún chat. El servidor tmux dedicado `agyrc` se iniciará automáticamente en cuanto envíes el primer mensaje de un chat desde la PWA.

### 2. No aparece el botón "Instalar PWA" en Chrome/Safari
* Asegúrate de estar accediendo a través de la URL **HTTPS** generada por `./scripts/tailscale-https.sh` y no por la IP HTTP directa.
* Comprueba que los certificados TLS de Tailscale estén habilitados en la consola de administración.

### 3. Un chat no responde
Cada chat corre en una sesión tmux `chat-<id>` cuyo agy lee de un FIFO y escribe en ficheros, así que la pantalla de la sesión no muestra nada útil: lo que hay que mirar son esos ficheros.
```bash
# Listar sesiones activas (una por chat con agy vivo)
tmux -L agyrc list-sessions

# Salida cruda de agy (NDJSON) y stderr del chat
tail -f data/chats/<id>.out data/chats/<id>.err

# Registro del runner (argv, spawn/exit, kill…) — también en la app: menú ⋯ → Registro
tail -n 50 data/chats/<id>.log

# Matar a mano el agy de un chat (el servidor lo detecta y cierra el turno)
tmux -L agyrc kill-session -t '=chat-<id>'
```

---

## Estructura del Proyecto

```
agy-rc/
├── package.json                 # Definición del paquete y scripts npm (start, dev, test)
├── .env.example                 # Plantilla de variables de entorno
├── .gitignore                   # Exclusiones de git (node_modules, .env, data, etc.)
├── README.md                    # Guía en inglés (README.es.md: esta guía)
├── LICENSE                      # Licencia MIT
├── docs/
│   └── CHAT.md                  # Protocolo stream-json de agy y diseño del chat
├── server/                      # Backend Node.js (Express + WebSockets + tmux)
│   ├── index.js                 # Punto de entrada HTTP/WS y servidor de estáticos
│   ├── config.js                # Carga de configuración
│   ├── build.js                 # Id de build y render del service worker
│   ├── auth.js                  # Middleware y validación de tokens Bearer
│   ├── agy.js                   # Modelos, comandos y helpers del CLI agy
│   ├── transcribe.js            # Dictado por voz con Gemini Live (WS /ws/transcribe)
│   ├── tmux.js                  # Wrapper de comandos tmux (-L agyrc)
│   ├── sessions.js              # Validación de rutas/nombres y navegador de carpetas
│   ├── routes.js                # API REST endpoints (/api/*): health, config, dirs, agy
│   └── chat/                    # CRUD de chats, runner (agy en tmux) y WS de streaming
├── public/                      # Frontend PWA (Vanilla JS)
│   ├── index.html               # Shell principal de la aplicación móvil
│   ├── manifest.json            # Web App Manifest (standalone, iconos)
│   ├── sw.js                    # Service Worker (caché offline de shell)
│   ├── css/
│   │   └── app.css              # Estilos móviles (safe-area, viewport dinámico, temas)
│   ├── js/
│   │   ├── main.js              # Bootstrap y coordinación de componentes
│   │   ├── api.js               # Cliente HTTP REST
│   │   ├── socket.js            # WebSocket con reconexión inteligente
│   │   ├── store.js             # Estado reactivo local
│   │   ├── pwa.js               # Registro de Service Worker e instalación
│   │   ├── updates.js           # Detección de nueva versión desplegada
│   │   ├── viewport.js          # Viewport dinámico móvil (teclado, safe-area)
│   │   ├── telemetry.js         # Errores del navegador → log del propio servidor (/api/client-log)
│   │   ├── chat/                # UI del chat (vista, topbar, compositor, dock…)
│   │   └── ui/                  # Componentes de interfaz compartidos (drawer, sheets...)
│   └── icons/                   # Iconos oficiales en varias resoluciones y maskable
├── scripts/                     # Automatización y DevOps
│   ├── agy-rc.service           # Unidad systemd de usuario (KillMode=process)
│   ├── install.sh               # Instalación idempotente y arranque
│   ├── start.sh                 # Inicio de producción
│   ├── dev.sh                   # Inicio de desarrollo con hot reload (--watch)
│   ├── status.sh                # Diagnóstico, estado de tmux y visor de logs
│   ├── tailscale-https.sh       # Proxy HTTPS con Tailscale Serve
│   ├── uninstall.sh             # Desinstalación limpia
│   └── tmux.conf                # Configuración optimizada de tmux (mouse, scroll, colores)
└── test/                        # Batería de pruebas unitarias e integración
```

---

## Referencia de la API REST

Por defecto no hay autenticación (la app solo es alcanzable dentro de tu tailnet). Si defines `AGY_TOKEN` en `.env`, todas las rutas (salvo `GET /api/health`) exigen `Authorization: Bearer <AGY_TOKEN>` o `?token=<AGY_TOKEN>`, y el WebSocket `?token=`; los ejemplos siguientes asumen que no hay token.

### 1. Estado de Salud del Servidor
```bash
curl -s http://127.0.0.1:8787/api/health
```
**Respuesta (200 OK):**
```json
{
  "ok": true,
  "version": "0.1.0",
  "hostname": "tu-servidor",
  "tmux": true,
  "agy": true,
  "uptime": 120.45
}
```

### 2. Configuración
```bash
curl -s http://127.0.0.1:8787/api/config
```

### 3. Listar Directorios Disponibles
```bash
curl -s "http://127.0.0.1:8787/api/dirs?path="
```

### 4. API de chats

El CRUD de chats (`GET/POST /api/chats`, `GET/PATCH/DELETE /api/chats/:id`, subida de adjuntos,
comandos de agy…) y el WebSocket de streaming (`/ws/chat?chat=<id>`) están documentados en
[`docs/CHAT.md`](docs/CHAT.md).

## Actualizaciones de la app

Cada despliegue (reinicio del servicio con código nuevo) genera un identificador de *build* (hash de
`public/`) que se expone en `/api/health` y da nombre a la caché del service worker (`/sw.js` se sirve
con él inyectado; no hay que subir versiones a mano). La app abierta lo comprueba al reconectar el
WebSocket, al volver a primer plano y cada 10 min: si cambió, muestra «Nueva versión disponible» y se
recarga sola en unos segundos (o espera a que toques «Actualizar» si tienes texto sin enviar). Los
estáticos se sirven con `Cache-Control: no-cache` (revalidación por ETag), así la recarga trae el
código nuevo también por HTTP, donde no hay service worker.

---

## 📄 Licencia

MIT © 2026 [Francisco Javier Guillén](https://github.com/fjguillen-96)

---

## ⚖️ Exención de responsabilidad (Disclaimer)

Antigravity, Gemini y Google son marcas registradas de Google LLC. `agy-rc` es una herramienta comunitaria independiente y no oficial, y no está afiliada, respaldada ni patrocinada por Google LLC ni Google DeepMind.



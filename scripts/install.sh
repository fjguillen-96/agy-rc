#!/usr/bin/env bash
# ==============================================================================
# agy-rc: Script de instalación completa e idempotente
# ==============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# Asegurar que el PATH incluya ~/.local/bin donde reside el CLI agy
export PATH="$HOME/.local/bin:$PATH"

# Procesar argumentos
NO_SERVICE=false
WITH_TOKEN=true
for arg in "$@"; do
  case "$arg" in
    --no-service)
      NO_SERVICE=true
      ;;
    --no-token)
      WITH_TOKEN=false
      ;;
    -h|--help)
      echo "Uso: $0 [--no-service] [--no-token]"
      echo "  --no-service   Instala dependencias y configura .env sin registrar la unidad systemd"
      echo "  --no-token     No genera AGY_TOKEN aleatorio al crear .env (por defecto genera un token seguro)"
      echo ""
      echo "Si ya existe un .env no se modifica: edita AGY_TOKEN a mano y reinicia el servicio."
      exit 0
      ;;
    *)
      echo "Opción desconocida: $arg"
      echo "Uso: $0 [--no-service] [--no-token]"
      exit 1
      ;;
  esac
done

# Compatibilidad con macOS o sistemas sin systemd
if [[ "$OSTYPE" == "darwin"* ]] || ! command -v systemctl >/dev/null 2>&1; then
  NO_SERVICE=true
fi

sed_inplace() {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# Configuración de colores
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  GREEN="$(tput setaf 2)"
  YELLOW="$(tput setaf 3)"
  RED="$(tput setaf 1)"
  BLUE="$(tput setaf 4)"
  CYAN="$(tput setaf 6)"
  BOLD="$(tput bold)"
  RESET="$(tput sgr0)"
else
  GREEN=""
  YELLOW=""
  RED=""
  BLUE=""
  CYAN=""
  BOLD=""
  RESET=""
fi

info() {
  echo "${CYAN}${BOLD}[INFO]${RESET} $*"
}

ok() {
  echo "${GREEN}${BOLD}[OK]${RESET} $*"
}

warn() {
  echo "${YELLOW}${BOLD}[AVISO]${RESET} $*"
}

err() {
  echo "${RED}${BOLD}[ERROR]${RESET} $*" >&2
}

echo "${BOLD}${BLUE}=====================================================${RESET}"
echo "${BOLD}${BLUE}        Instalador de agy-rc (DevOps & Setup)        ${RESET}"
echo "${BOLD}${BLUE}=====================================================${RESET}"
echo ""

# ------------------------------------------------------------------------------
# 1. Comprobación de requisitos y dependencias
# ------------------------------------------------------------------------------
info "Comprobando dependencias del sistema..."

# Node.js (requerido >= 20.6)
if ! command -v node >/dev/null 2>&1; then
  err "Node.js no está instalado. Se requiere Node.js >= 20.6."
  exit 1
fi

NODE_VER="$(node -v | sed 's/^v//')"
if ! node -e 'const [M, m] = process.versions.node.split(".").map(Number); process.exit((M > 20 || (M === 20 && m >= 6)) ? 0 : 1)' >/dev/null 2>&1; then
  err "La versión de Node.js instalada ($NODE_VER) no cumple el requisito mínimo (>= 20.6)."
  exit 1
fi
ok "Node.js $NODE_VER detectado (>= 20.6)."

# npm
if ! command -v npm >/dev/null 2>&1; then
  err "npm no está instalado. Por favor, instálalo en tu sistema."
  exit 1
fi
ok "npm detectado ($(npm -v))."

# tmux
if ! command -v tmux >/dev/null 2>&1; then
  err "tmux no está instalado. Por favor, instálalo (ej. sudo pacman -S tmux o sudo apt install tmux)."
  exit 1
fi
ok "tmux detectado ($(tmux -V))."

# agy CLI
if command -v agy >/dev/null 2>&1; then
  ok "CLI Antigravity (agy) detectado en $(command -v agy)."
else
  warn "No se encontró el ejecutable 'agy' en el PATH actual."
  warn "Para instalarlo o configurarlo, consulta: https://antigravity.google"
  warn "Continuando la instalación (podrás instalarlo o agregarlo al PATH más tarde en ~/.local/bin/agy)..."
fi

# Tailscale
TS_IP=""
if command -v tailscale >/dev/null 2>&1; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
  if [[ -n "$TS_IP" ]]; then
    ok "Tailscale detectado. IP asignada: $TS_IP"
  else
    warn "Tailscale está instalado pero no parece conectado a una red tailnet."
  fi
else
  warn "Tailscale no está instalado. agy-rc funcionará en red local, pero se recomienda Tailscale para acceso remoto seguro."
fi

# ------------------------------------------------------------------------------
# 2. Instalación de dependencias Node.js
# ------------------------------------------------------------------------------
echo ""
info "Instalando dependencias de producción de Node.js..."
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi
ok "Dependencias de Node.js instaladas correctamente."

# ------------------------------------------------------------------------------
# 3. Configuración del entorno (.env)
# ------------------------------------------------------------------------------
echo ""
TOKEN=""
if [[ ! -f .env ]]; then
  info "Creando archivo .env a partir de .env.example..."
  cp .env.example .env
  
  if [[ "$WITH_TOKEN" = true ]]; then
    if command -v openssl >/dev/null 2>&1; then
      TOKEN="$(openssl rand -hex 24)"
    else
      TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    fi
    sed_inplace "s|^AGY_TOKEN=.*|AGY_TOKEN=${TOKEN}|" .env
  fi
  # Ajustar la raíz de proyectos por defecto al $HOME/projects del usuario
  sed_inplace "s|^AGY_PROJECTS_ROOT=.*|AGY_PROJECTS_ROOT=${HOME}/projects|" .env
  if [[ -n "$TOKEN" ]]; then
    ok "Archivo .env generado con token y AGY_PROJECTS_ROOT=${HOME}/projects."
  else
    ok "Archivo .env generado sin token y AGY_PROJECTS_ROOT=${HOME}/projects."
    warn "Sin AGY_TOKEN, cualquier equipo que alcance el puerto del servidor podrá ejecutar comandos en esta máquina."
  fi
else
  ok "Archivo .env existente detectado. No se sobrescribirá."
  TOKEN="$(grep -E '^AGY_TOKEN=' .env | head -n 1 | cut -d'=' -f2- | tr -d ' "' || true)"
fi

# ------------------------------------------------------------------------------
# 4. Creación de directorios necesarios
# ------------------------------------------------------------------------------
mkdir -p data
mkdir -p "$HOME/projects"

PORT="$(grep -E '^PORT=' .env 2>/dev/null | head -n 1 | cut -d'=' -f2 | tr -d ' "' || true)"
PORT="${PORT:-8787}"

# ------------------------------------------------------------------------------
# 5. Instalación y arranque de la unidad systemd de usuario
# ------------------------------------------------------------------------------
if [[ "$NO_SERVICE" = false ]]; then
  echo ""
  info "Configurando el servicio de usuario systemd (agy-rc.service)..."
  
  SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SYSTEMD_USER_DIR"

  # Sustitución de ruta en la unidad según la ubicación real del repositorio
  if [[ "$REPO_DIR" == "$HOME/"* ]]; then
    SERVICE_REPO_PATH="%h/${REPO_DIR#"$HOME/"}"
  else
    SERVICE_REPO_PATH="$REPO_DIR"
  fi

  sed "s|%h/projects/agy-rc|${SERVICE_REPO_PATH}|g" "$REPO_DIR/scripts/agy-rc.service" > "$SYSTEMD_USER_DIR/agy-rc.service"
  ok "Unidad instalada en $SYSTEMD_USER_DIR/agy-rc.service (Ruta: $SERVICE_REPO_PATH)."

  # Recargar systemd y habilitar/iniciar el servicio
  systemctl --user daemon-reload
  systemctl --user enable --now agy-rc
  ok "Servicio agy-rc habilitado e iniciado con systemd --user."

  # Habilitar persistencia de procesos tras cerrar sesión (linger)
  if command -v loginctl >/dev/null 2>&1; then
    if loginctl enable-linger "$USER" 2>/dev/null; then
      ok "Linger activado para '$USER' (el servicio persistirá tras reiniciar el PC)."
    else
      warn "No se pudo activar linger sin privilegios."
      warn "Para que el servicio inicie tras reiniciar sin hacer login previo, ejecuta:"
      warn "  sudo loginctl enable-linger $USER"
    fi
  fi

  # Comprobar salud del servicio
  info "Esperando 2 segundos para verificar el arranque del servicio..."
  sleep 2

  if systemctl --user is-active --quiet agy-rc; then
    ok "El servicio systemd está ACTIVO."
  else
    warn "El servicio no parece estar activo. Comprueba los logs con: journalctl --user -u agy-rc -n 20"
  fi

  # Health check vía curl si curl está disponible
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      ok "Comprobación de salud HTTP exitosa en http://127.0.0.1:${PORT}/api/health."
    else
      warn "No se pudo contactar con http://127.0.0.1:${PORT}/api/health de forma inmediata."
    fi
  fi
else
  info "Opción --no-service activada: se omitió la instalación del servicio systemd."
fi

# ------------------------------------------------------------------------------
# 6. Resumen final e instrucciones
# ------------------------------------------------------------------------------
HOSTNAME_NAME="$(hostname 2>/dev/null || echo 'localhost')"

echo ""
echo "${BOLD}${GREEN}=====================================================${RESET}"
echo "${BOLD}${GREEN}        ¡Instalación de agy-rc completada!           ${RESET}"
echo "${BOLD}${GREEN}=====================================================${RESET}"
echo ""
echo "Acceso al servidor:"
echo "  • Local:         ${CYAN}http://127.0.0.1:${PORT}${RESET}"
echo "  • Hostname:      ${CYAN}http://${HOSTNAME_NAME}:${PORT}${RESET}"
if [[ -n "$TS_IP" ]]; then
  echo "  • Tailscale IP:  ${BLUE}http://${TS_IP}:${PORT}${RESET}"
fi
echo ""
if [[ -n "$TOKEN" ]]; then
  echo "${BOLD}Token de autenticación configurado:${RESET}"
  echo "  ${YELLOW}${BOLD}${TOKEN}${RESET}"
  echo "  (La PWA lo pedirá la primera vez)"
  echo ""
else
  echo "${BOLD}${YELLOW}Sin token:${RESET} cualquier dispositivo que alcance el puerto ${PORT} puede usar la app y ejecutar comandos."
  echo "  Para exigir uno: genera un token con ${CYAN}openssl rand -hex 24${RESET}, ponlo en ${CYAN}AGY_TOKEN=${RESET} dentro de .env"
  echo "  y reinicia el servidor."
  echo ""
fi

echo "${BOLD}${YELLOW}IMPORTANTE PARA INSTALAR LA PWA:${RESET}"
echo "Para instalar agy-rc como PWA en tu móvil Android (Chrome) o iOS (Safari),"
echo "es obligatorio acceder mediante HTTPS con un certificado válido."
echo ""
echo "Configura HTTPS automáticamente con Tailscale ejecutando:"
echo "  ${BOLD}${CYAN}./scripts/tailscale-https.sh${RESET}"
echo ""
if [[ "$NO_SERVICE" = false ]]; then
  echo "Comandos de gestión útiles:"
  echo "  • Ver estado:     ${CYAN}./scripts/status.sh${RESET}"
  echo "  • Ver logs:       ${CYAN}journalctl --user -u agy-rc -f${RESET}"
  echo "  • Reiniciar:      ${CYAN}systemctl --user restart agy-rc${RESET}"
else
  echo "No se ha registrado ningún servicio. Para arrancar el servidor:"
  echo "  • En primer plano: ${CYAN}./scripts/start.sh${RESET}  (o ${CYAN}npm start${RESET})"
  echo "  • Ver estado:      ${CYAN}./scripts/status.sh${RESET}"
fi
echo "====================================================="

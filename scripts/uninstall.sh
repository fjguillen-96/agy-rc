#!/usr/bin/env bash
# ==============================================================================
# agy-rc: Script de desinstalación del servicio y limpieza
# ==============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

ASSUME_YES=false
for arg in "$@"; do
  case "$arg" in
    -y|--yes)
      ASSUME_YES=true
      ;;
    -h|--help)
      echo "Uso: $0 [-y|--yes]"
      echo "  -y, --yes   Confirma automáticamente todas las preguntas de desinstalación"
      exit 0
      ;;
    *)
      echo "Opción desconocida: $arg"
      echo "Uso: $0 [-y|--yes]"
      exit 1
      ;;
  esac
done

# Colores si TTY
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

echo "${BOLD}${RED}=====================================================${RESET}"
echo "${BOLD}${RED}           Desinstalación de agy-rc                  ${RESET}"
echo "${BOLD}${RED}=====================================================${RESET}"
echo ""

if [[ "$ASSUME_YES" = false ]]; then
  echo "${YELLOW}Esta acción detendrá y eliminará el servicio systemd de agy-rc.${RESET}"
  echo "El código fuente del repositorio y los archivos de configuración (.env, data/) se mantendrán intactos."
  echo ""
  read -rp "¿Deseas continuar con la desinstalación? [s/N]: " RESP
  case "$RESP" in
    [sS]|[sS][iI]|[yY]|[yY][eE][sS])
      ;;
    *)
      echo "Desinstalación cancelada por el usuario."
      exit 0
      ;;
  esac
fi

# 1. Detener y deshabilitar servicio systemd
echo ""
info "Deteniendo y deshabilitando el servicio systemd de usuario (agy-rc)..."
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now agy-rc 2>/dev/null || true
  
  SERVICE_FILE="$HOME/.config/systemd/user/agy-rc.service"
  if [[ -f "$SERVICE_FILE" ]]; then
    rm -f "$SERVICE_FILE"
    ok "Fichero de servicio eliminado ($SERVICE_FILE)."
  else
    info "No se encontró el fichero $SERVICE_FILE."
  fi
  
  systemctl --user daemon-reload
  ok "systemd daemon-reload ejecutado."
else
  warn "systemctl no disponible."
fi

# 2. Servidor tmux
echo ""
TMUX_SOCK="${AGY_TMUX_SOCKET:-agyrc}"
if [[ -f .env ]]; then
  SOCK_ENV="$(grep -E '^AGY_TMUX_SOCKET=' .env 2>/dev/null | head -n 1 | cut -d'=' -f2 | tr -d ' "' || true)"
  if [[ -n "$SOCK_ENV" ]]; then
    TMUX_SOCK="$SOCK_ENV"
  fi
fi

KILL_TMUX=false
if [[ "$ASSUME_YES" = true ]]; then
  KILL_TMUX=true
else
  read -rp "¿Deseas cerrar todas las sesiones activas y matar el servidor tmux dedicado (-L ${TMUX_SOCK})? [s/N]: " RESP_TMUX
  case "$RESP_TMUX" in
    [sS]|[sS][iI]|[yY]|[yY][eE][sS])
      KILL_TMUX=true
      ;;
    *)
      KILL_TMUX=false
      ;;
  esac
fi

if [[ "$KILL_TMUX" = true ]]; then
  if command -v tmux >/dev/null 2>&1; then
    tmux -L "${TMUX_SOCK}" kill-server 2>/dev/null || true
    ok "Servidor tmux ${TMUX_SOCK} y sesiones finalizadas."
  fi
else
  info "Servidor tmux conservado (las sesiones continúan en ejecución en segundo plano)."
fi

# 3. Tailscale serve
echo ""
RESET_TS=false
if [[ "$ASSUME_YES" = true ]]; then
  RESET_TS=true
else
  read -rp "¿Deseas restablecer la configuración de Tailscale Serve (eliminar proxy HTTPS)? [s/N]: " RESP_TS
  case "$RESP_TS" in
    [sS]|[sS][iI]|[yY]|[yY][eE][sS])
      RESET_TS=true
      ;;
    *)
      RESET_TS=false
      ;;
  esac
fi

if [[ "$RESET_TS" = true ]]; then
  if command -v tailscale >/dev/null 2>&1; then
    tailscale serve reset 2>/dev/null || true
    ok "Configuración de Tailscale Serve restablecida."
  fi
else
  info "Configuración de Tailscale Serve conservada."
fi

echo ""
echo "${BOLD}${GREEN}=====================================================${RESET}"
echo "${BOLD}${GREEN}        Desinstalación completada con éxito          ${RESET}"
echo "${BOLD}${GREEN}=====================================================${RESET}"
echo "Nota: El directorio del proyecto, los datos locales (data/) y el archivo .env se han conservado."
echo "Si deseas eliminar completamente los ficheros, borra este directorio manualmente."

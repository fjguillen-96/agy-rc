#!/usr/bin/env bash
# ==============================================================================
# agy-rc: Configuración de HTTPS seguro mediante Tailscale Serve
# ==============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# Colores y estilos
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

# Comprobar si se solicitó desactivar
if [[ "${1:-}" == "--off" || "${1:-}" == "--reset" ]]; then
  info "Desactivando configuración de Tailscale Serve..."
  if ! command -v tailscale >/dev/null 2>&1; then
    err "Tailscale no está instalado."
    exit 1
  fi

  set +e
  RESET_OUT="$(tailscale serve reset 2>&1)"
  RESET_EXIT=$?
  set -e

  if [[ $RESET_EXIT -eq 0 ]]; then
    ok "Tailscale Serve ha sido desactivado y reseteado."
  else
    err "Fallo al resetear Tailscale Serve:"
    echo "$RESET_OUT" >&2
    if echo "$RESET_OUT" | grep -iqE "permission|access denied|operator"; then
      warn "Prueba ejecutando: sudo tailscale serve reset"
      warn "O concede permisos a tu usuario: sudo tailscale set --operator=$USER"
    fi
    exit $RESET_EXIT
  fi
  exit 0
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Uso: $0 [--off]"
  echo "  (sin args)  Habilita proxy HTTPS en segundo plano hacia agy-rc (puerto 443 -> PORT)"
  echo "  --off       Desactiva Tailscale Serve y elimina el reenvío"
  exit 0
fi

echo "${BOLD}${BLUE}=====================================================${RESET}"
echo "${BOLD}${BLUE}       Configuración de HTTPS con Tailscale Serve    ${RESET}"
echo "${BOLD}${BLUE}=====================================================${RESET}"
echo ""

# 1. Comprobar instalación de Tailscale
if ! command -v tailscale >/dev/null 2>&1; then
  err "Tailscale no está instalado en este equipo."
  err "Visita https://tailscale.com/download para instalarlo."
  exit 1
fi

# 2. Comprobar estado de conexión
info "Comprobando estado de Tailscale..."
TS_JSON="$(tailscale status --json 2>/dev/null || true)"
if [[ -z "$TS_JSON" ]]; then
  err "No se pudo consultar el estado del servicio de Tailscale."
  err "Asegúrate de que el daemon tailscaled esté activo."
  exit 1
fi

BACKEND_STATE="$(echo "$TS_JSON" | grep -o '"BackendState":[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"BackendState":[[:space:]]*"([^"]*)".*/\1/' || true)"

if [[ "$BACKEND_STATE" != "Running" ]]; then
  err "Tailscale no está conectado (BackendState: '${BACKEND_STATE:-Desconocido}')."
  err "Inicia sesión y conéctate primero ejecutando: tailscale up"
  exit 1
fi
ok "Tailscale está conectado y operativo."

# 3. Obtener puerto configurado
PORT="8787"
if [[ -f .env ]]; then
  PORT_ENV="$(grep -E '^PORT=' .env | head -n 1 | cut -d'=' -f2 | tr -d ' "' || true)"
  if [[ -n "$PORT_ENV" ]]; then
    PORT="$PORT_ENV"
  fi
fi

# 4. Extraer DNSName de Self sin el punto final
DNS_NAME="$(echo "$TS_JSON" | grep -o '"DNSName":[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"DNSName":[[:space:]]*"([^"]*)".*/\1/' | sed 's/\.$//' || true)"

# 5. Ejecutar tailscale serve
info "Configurando HTTPS en segundo plano (https://...:443 -> http://127.0.0.1:${PORT})..."

OUTPUT=""
set +e
# stdin cerrado + timeout: si Serve no está habilitado en la tailnet, tailscale se queda
# esperando a que lo actives en la web; aquí capturamos ese mensaje y no bloqueamos.
OUTPUT="$(timeout 40 tailscale serve --bg --https=443 "http://127.0.0.1:${PORT}" </dev/null 2>&1)"
SERVE_EXIT=$?
if echo "$OUTPUT" | grep -q "Serve is not enabled"; then
  SERVE_EXIT=2
fi
set -e

if [[ $SERVE_EXIT -ne 0 ]]; then
  err "Error al ejecutar 'tailscale serve' (código $SERVE_EXIT):"
  echo "$OUTPUT" >&2
  echo ""

  # Serve no habilitado en la tailnet: hay que activarlo una vez desde la consola web
  if echo "$OUTPUT" | grep -q "Serve is not enabled"; then
    ENABLE_URL="$(echo "$OUTPUT" | grep -o 'https://login.tailscale.com/f/serve[^ ]*' | head -n 1)"
    warn "Tailscale Serve no está habilitado en tu tailnet. Actívalo (una sola vez) aquí:"
    warn "  ${BOLD}${ENABLE_URL:-https://login.tailscale.com/admin/dns}${RESET}"
    warn "En la misma consola activa también 'MagicDNS' y 'HTTPS Certificates' (Admin → DNS)."
    warn "Después vuelve a ejecutar: ./scripts/tailscale-https.sh"
    echo ""
    exit 2
  fi

  # Sugerencia de permisos de operador
  if echo "$OUTPUT" | grep -iqE "permission|access denied|operator"; then
    warn "Permiso denegado al configurar Tailscale Serve."
    warn "Para permitir que el usuario '$USER' gestione Tailscale sin sudo, ejecuta una vez:"
    warn "  ${BOLD}sudo tailscale set --operator=$USER${RESET}"
    warn "O bien ejecuta este script con sudo:"
    warn "  ${BOLD}sudo ./scripts/tailscale-https.sh${RESET}"
    echo ""
  fi

  # Sugerencia de configuración DNS / Certificados en consola web
  if echo "$OUTPUT" | grep -iqE "https|certificate|cert|tls|magicdns|dns"; then
    warn "Requisitos de HTTPS en Tailscale:"
    warn "1. Accede al panel de administración: ${BOLD}https://login.tailscale.com/admin/dns${RESET}"
    warn "2. Activa 'MagicDNS'."
    warn "3. Activa 'HTTPS Certificates' (permite a Tailscale solicitar certificados TLS válidos)."
    echo ""
  fi

  exit $SERVE_EXIT
fi

ok "Tailscale Serve configurado con éxito."
echo ""
info "Estado actual de reenvíos de Tailscale:"
tailscale serve status || true
echo ""

echo "${BOLD}${GREEN}=====================================================${RESET}"
echo "${BOLD}${GREEN}             HTTPS habilitado para la PWA            ${RESET}"
echo "${BOLD}${GREEN}=====================================================${RESET}"
echo ""
if [[ -n "$DNS_NAME" ]]; then
  echo "URL segura de acceso e instalación PWA:"
  echo "  ${CYAN}${BOLD}https://${DNS_NAME}${RESET}"
  echo ""
  echo "Instrucciones de instalación:"
  echo "  • Android (Chrome): Abre la URL anterior y pulsa en 'Instalar aplicación'."
  echo "  • iOS (Safari):    Abre la URL anterior, pulsa 'Compartir' y 'Añadir a pantalla de inicio'."
else
  echo "Accede a la URL HTTPS proporcionada por tu tailnet."
fi
echo ""
echo "Para desactivar HTTPS en cualquier momento: ./scripts/tailscale-https.sh --off"
echo "====================================================="

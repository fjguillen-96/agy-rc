#!/usr/bin/env bash
# ==============================================================================
# agy-rc: Script de inicio en modo desarrollo (recarga automática con --watch)
# ==============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# Asegurar que el PATH incluya ~/.local/bin donde reside el CLI agy
export PATH="$HOME/.local/bin:$PATH"

# Cargar variables de .env si existe
if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"

# Formato y colores en caso de terminal interactivo
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  GREEN="$(tput setaf 2)"
  BLUE="$(tput setaf 4)"
  CYAN="$(tput setaf 6)"
  BOLD="$(tput bold)"
  RESET="$(tput sgr0)"
else
  GREEN=""
  BLUE=""
  CYAN=""
  BOLD=""
  RESET=""
fi

echo "${BOLD}${GREEN}=== Modo Desarrollo agy-rc ===${RESET}"
echo "Escuchando en: ${CYAN}http://${HOST}:${PORT}${RESET}"

# Obtener y mostrar la IP de Tailscale si está disponible
if command -v tailscale >/dev/null 2>&1; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
  if [[ -n "$TS_IP" ]]; then
    echo "URL Tailscale: ${BLUE}http://${TS_IP}:${PORT}${RESET}"
  fi
fi

echo "Iniciando servidor con recarga en caliente (node --watch)..."
echo "------------------------------------------------------------"

exec /usr/bin/env node --watch --env-file-if-exists=.env server/index.js

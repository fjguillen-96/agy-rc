#!/usr/bin/env bash
# ==============================================================================
# agy-rc: Diagnóstico y estado general del servicio y sesiones
# ==============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if [[ "${1:-}" == "-f" || "${1:-}" == "--follow" ]]; then
  echo "Siguiendo logs en tiempo real de agy-rc (Ctrl+C para salir)..."
  exec journalctl --user -u agy-rc -f
fi

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

PORT="8787"
TMUX_SOCK="${AGY_TMUX_SOCKET:-agyrc}"
if [[ -f .env ]]; then
  PORT_ENV="$(grep -E '^PORT=' .env 2>/dev/null | head -n 1 | cut -d'=' -f2 | tr -d ' "' || true)"
  if [[ -n "$PORT_ENV" ]]; then
    PORT="$PORT_ENV"
  fi
  SOCK_ENV="$(grep -E '^AGY_TMUX_SOCKET=' .env 2>/dev/null | head -n 1 | cut -d'=' -f2 | tr -d ' "' || true)"
  if [[ -n "$SOCK_ENV" ]]; then
    TMUX_SOCK="$SOCK_ENV"
  fi
fi

echo "${BOLD}${BLUE}=====================================================${RESET}"
echo "${BOLD}${BLUE}               Estado del Sistema: agy-rc            ${RESET}"
echo "${BOLD}${BLUE}=====================================================${RESET}"
echo ""

# 1. Estado del servicio systemd
echo "${BOLD}${CYAN}[1] Servicio systemd (agy-rc.service)${RESET}"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user is-active --quiet agy-rc 2>/dev/null; then
    echo "  Estado: ${GREEN}${BOLD}ACTIVO / EN EJECUCIÓN${RESET}"
  else
    echo "  Estado: ${YELLOW}${BOLD}INACTIVO O DETENIDO${RESET}"
  fi
  echo ""
  systemctl --user status agy-rc --no-pager -l 2>&1 | head -n 15 || true
else
  echo "  systemctl no disponible en este entorno."
fi
echo ""

# 2. Sesiones tmux activas
echo "${BOLD}${CYAN}[2] Sesiones en tmux (socket -L ${TMUX_SOCK})${RESET}"
if command -v tmux >/dev/null 2>&1; then
  set +e
  TMUX_OUT="$(tmux -L "${TMUX_SOCK}" list-sessions -F '#{session_name}  creada:#{t:session_created}  clientes:#{session_attached}  cmd:#{pane_current_command}' 2>&1)"
  TMUX_EXIT=$?
  set -e
  if [[ $TMUX_EXIT -eq 0 && -n "$TMUX_OUT" ]]; then
    echo "$TMUX_OUT" | sed 's/^/  • /'
  else
    echo "  (ninguna sesión activa / servidor tmux ${TMUX_SOCK} detenido)"
  fi
else
  echo "  tmux no instalado."
fi
echo ""

# 3. Estado de Tailscale Serve
echo "${BOLD}${CYAN}[3] Estado de Tailscale Serve (HTTPS)${RESET}"
if command -v tailscale >/dev/null 2>&1; then
  set +e
  SERVE_OUT="$(tailscale serve status 2>&1)"
  set -e
  if [[ -n "$SERVE_OUT" ]]; then
    echo "$SERVE_OUT" | sed 's/^/  /'
  else
    echo "  (sin configuración activa de tailscale serve)"
  fi
else
  echo "  Tailscale no instalado."
fi
echo ""

# 4. URLs de acceso
echo "${BOLD}${CYAN}[4] URLs de acceso disponibles${RESET}"
echo "  • Local:        http://127.0.0.1:${PORT}"
if command -v tailscale >/dev/null 2>&1; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
  if [[ -n "$TS_IP" ]]; then
    echo "  • Tailscale IP: http://${TS_IP}:${PORT}"
  fi
  TS_DNS="$(tailscale status --json 2>/dev/null | grep -o '"DNSName":[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"DNSName":[[:space:]]*"([^"]*)".*/\1/' | sed 's/\.$//' || true)"
  if [[ -n "$TS_DNS" ]]; then
    echo "  • HTTPS (PWA):  https://${TS_DNS}"
  fi
fi
echo ""

# 5. Últimas líneas del journal
echo "${BOLD}${CYAN}[5] Últimas 20 líneas de logs (journalctl)${RESET}"
if command -v journalctl >/dev/null 2>&1; then
  journalctl --user -u agy-rc -n 20 --no-pager 2>&1 || true
else
  echo "  journalctl no disponible."
fi
echo ""
echo "-----------------------------------------------------"
echo "Para seguir los logs en vivo: ${BOLD}./scripts/status.sh -f${RESET}"
echo "====================================================="

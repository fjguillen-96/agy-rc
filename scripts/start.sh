#!/usr/bin/env bash
# ==============================================================================
# agy-rc: Script de inicio en producción / primer plano
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

exec /usr/bin/env node --env-file-if-exists=.env server/index.js

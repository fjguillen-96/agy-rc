#!/bin/sh
# agy falso para los tests de chat sobre tmux (test/chat-tmux.test.js): imita el protocolo
# stream-json (init → step_update agent_response → result) sin lanzar Antigravity.
#   línea con "slow"  → espera 1,5 s antes de responder (turno en vuelo durante un "reinicio")
#   línea con "quit"  → sale con código 3 sin responder (tras la espera, si también dice "slow")
#   línea con "stderr"→ escribe además una línea por stderr
# Como el agy real, tarda un poco en morir tras SIGTERM (limpieza): el marcador exit del wrapper
# llega unos cientos de ms después del kill.
trap 'sleep 0.4; exit 143' TERM
step=0
printf '{"event":"init","conversation_id":"conv-fake","init":{"cwd":"%s"}}\n' "$PWD"
while IFS= read -r line; do
  step=$((step + 1))
  case "$line" in *slow*) sleep 1.5;; esac
  case "$line" in *quit*) exit 3;; esac
  case "$line" in *stderr*) echo "ruido en stderr" >&2;; esac
  # el texto del usuario viene en message.content: se extrae de forma tosca para el eco
  text=$(printf '%s' "$line" | sed -e 's/.*"content":"//' -e 's/"}}$//')
  printf '{"event":"step_update","step_update":{"conversation_id":"conv-fake","step_index":%d,"step_type":"agent_response","state":"ACTIVE","text_delta":"eco: "}}\n' "$step"
  printf '{"event":"step_update","step_update":{"conversation_id":"conv-fake","step_index":%d,"step_type":"agent_response","state":"ACTIVE","text_delta":"%s"}}\n' "$step" "$text"
  printf '{"event":"step_update","step_update":{"conversation_id":"conv-fake","step_index":%d,"step_type":"agent_response","state":"DONE"}}\n' "$step"
  printf '{"event":"result","result":{"status":"OK","conversation_id":"conv-fake"}}\n'
done

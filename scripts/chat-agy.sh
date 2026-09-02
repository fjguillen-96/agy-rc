#!/bin/sh
# Wrapper que corre DENTRO de la sesión tmux de un chat de agy-rc (ver server/chat/tmux-proc.js).
# Lanza agy en modo stream-json con stdin desde un FIFO y stdout/stderr en ficheros append, y deja
# dos marcadores JSON en el fichero de salida (`{"agyrc":"spawn"}` con el pid y `{"agyrc":"exit"}`
# con el código) para que el servidor sepa a quién matar y cuándo terminó, aunque se haya reiniciado
# mientras tanto.
#
# Uso: chat-agy.sh <fifo-stdin> <fichero-stdout> <fichero-stderr> <agy> [args…]
#
# `0<>` abre el FIFO en lectura+escritura: así el open no bloquea esperando a un escritor y agy
# nunca ve EOF cuando el servidor cierra su extremo tras cada línea (el servidor abre el FIFO en
# O_WRONLY|O_NONBLOCK, que falla con ENXIO si nadie lee: es su forma de saber que agy ha muerto).
set -u
IN=$1; OUT=$2; ERR=$3; shift 3
export PATH="$HOME/.local/bin:$PATH"

"$@" 0<>"$IN" >>"$OUT" 2>>"$ERR" &
pid=$!
# Salto de línea previo por si el fichero terminara en una línea sin cerrar (el parser ignora vacías).
printf '\n{"agyrc":"spawn","pid":%d}\n' "$pid" >>"$OUT"

# kill-session / SIGTERM al wrapper → reenviar a agy (que es quien tiene que terminar limpiamente).
trap 'kill -TERM "$pid" 2>/dev/null' TERM HUP INT
wait "$pid"; code=$?
# `wait` vuelve antes de tiempo si saltó la trampa: esperar hasta que el hijo muera de verdad.
while kill -0 "$pid" 2>/dev/null; do wait "$pid"; code=$?; done
printf '\n{"agyrc":"exit","code":%d}\n' "$code" >>"$OUT"

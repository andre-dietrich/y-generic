#!/usr/bin/env bash
# Start a y-websocket relay for a classroom in docker and print what to enter.
#
#   ./test/websocket/relay.sh                 # ws://<LAN address>:1234
#   MODE=https ./test/websocket/relay.sh      # wss://<LAN address>:1234 with a self-signed certificate
#   PORT=9000 IP=192.168.1.10 ./test/websocket/relay.sh   # override port, and the detected address
#   ./test/websocket/relay.sh stop            # stop and remove the container
#
# Runs the liascript/websocket-relay image (built from
# Docker/websocket/Dockerfile: the edrys-websocket-server pinned to a
# commit) with --network host, so the entrypoint detects the LAN address
# itself (Docker/websocket/entrypoint.sh) and, with MODE=https, generates a
# self-signed certificate for it on first start - so the same command works
# for anyone, without knowing their address upfront.
#
# --network host is used here for the same reason as for the Gun relay (see
# test/gun/relay.sh): the entrypoint's `ip route get` then sees the real
# host address rather than a docker-bridge-internal one. This is a plain
# WebSocket server with no multicast, so ordinary port publishing (`-p`)
# may well work for LAN reachability too - not measured either way.
#
# Only the https certificate lives in the docker volume
# websocket-relay-data; the document is not persisted, the clients refill
# the relay's empty copy after a restart (test/dummy/e2e-edrys-ws.ts,
# check 5). The server itself is baked into the image.
set -euo pipefail

NAME="${NAME:-websocket-relay}"
PORT="${PORT:-1234}"
MODE="${MODE:-http}"
IMAGE="${IMAGE:-liascript/websocket-relay:latest}"

if [ "${1:-}" = "stop" ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 && echo "$NAME stopped and removed" || echo "$NAME was not running"
  exit 0
fi
case "$MODE" in http|https) ;; *) echo "MODE must be http or https" >&2; exit 1 ;; esac

case "$(uname -s 2>/dev/null || true)" in
  Linux) ;;
  *)
    echo "This needs Docker's --network host, which only gives the real LAN address on Linux"
    echo "(on macOS/Windows Docker Desktop it's an internal VM address, unreachable from other devices)."
    echo "Run the server directly instead, no Docker:"
    echo
    echo "  npm install github:edrys-labs/edrys-websocket-server ws@8 yjs@13"
    echo "  PORT=$PORT node node_modules/edrys-websocket-server/src/server.js --host=0.0.0.0"
    echo
    echo "Then enter ws://<your LAN IP>:$PORT as the server URL (find the IP via ipconfig/ifconfig)."
    exit 0
    ;;
esac

docker rm -f "$NAME" >/dev/null 2>&1 || true

EXTRA_ARGS=()
[ -n "${IP:-}" ] && EXTRA_ARGS+=(-e "RELAY_IP=$IP")

docker run -d --name "$NAME" --network host -v websocket-relay-data:/srv \
  -e PORT="$PORT" -e MODE="$MODE" "${EXTRA_ARGS[@]}" \
  "$IMAGE" >/dev/null

printf 'starting %s (first start pulls %s) ' "$NAME" "$IMAGE"
for _ in $(seq 1 90); do
  if curl -sk -o /dev/null "$MODE://localhost:$PORT/"; then echo; break; fi
  printf '.'; sleep 1
done
if ! curl -sk -o /dev/null "$MODE://localhost:$PORT/"; then
  echo; echo "relay did not come up; docker logs $NAME" >&2; exit 1
fi

echo
docker logs "$NAME" 2>/dev/null
SCHEME=ws; [ "$MODE" = https ] && SCHEME=wss
echo "Same machine: $SCHEME://127.0.0.1:$PORT"

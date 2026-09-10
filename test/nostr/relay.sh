#!/usr/bin/env bash
# Start a Nostr relay for a classroom in docker and print what to enter.
#
#   ./test/nostr/relay.sh                 # ws://<LAN address>:8766
#   MODE=https ./test/nostr/relay.sh      # wss://<LAN address>:8766 with a self-signed certificate
#   PORT=9000 IP=192.168.1.10 ./test/nostr/relay.sh   # override port, and the detected address
#   ./test/nostr/relay.sh stop            # stop and remove the container
#
# Runs the liascript/nostr-relay image (built from Docker/nostr/Dockerfile)
# with --network host, so the entrypoint detects the LAN address itself
# (Docker/nostr/entrypoint.sh) and, with MODE=https, generates a
# self-signed certificate for it on first start - so the same command
# works for anyone, without knowing their address upfront.
#
# --network host is still used here the same way as for the Gun relay
# (see test/gun/relay.sh), so the entrypoint's `ip route get` sees the
# real host address rather than a docker-bridge-internal one - but unlike
# Gun, this relay has no multicast and no long-poll behavior, just a plain
# WebSocket server, so ordinary port publishing (`-p`) may well work fine
# for LAN reachability too. Not yet measured on a real LAN either way.
#
# Persisted data (replaceable/addressable events - see relay.js, used by
# NostrTransport's `persistent` mode - and the https certificate) lives in
# the docker volume nostr-relay-data, so a restart keeps it; the app
# itself is baked into the liascript/nostr-relay image.
set -euo pipefail

NAME="${NAME:-nostr-relay}"
PORT="${PORT:-8766}"
MODE="${MODE:-http}"
IMAGE="${IMAGE:-liascript/nostr-relay:latest}"

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
    echo "Run the relay directly instead, no Docker:"
    echo
    echo "  npm install ws"
    echo "  PORT=$PORT node Docker/nostr/relay.js"
    echo
    echo "Then enter ws://<your LAN IP>:$PORT as a relay in NostrTransport (find the IP via ipconfig/ifconfig)."
    exit 0
    ;;
esac

docker rm -f "$NAME" >/dev/null 2>&1 || true

EXTRA_ARGS=()
[ -n "${IP:-}" ] && EXTRA_ARGS+=(-e "RELAY_IP=$IP")

docker run -d --name "$NAME" --network host -v nostr-relay-data:/srv \
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
echo "Firewall: allow $PORT/tcp (e.g. sudo ufw allow $PORT/tcp)."
if [ "$MODE" = https ]; then
  echo "Open https://<address>:$PORT/ once in a browser on this and every other device and accept the"
  echo "self-signed certificate warning before using the wss:// address above - otherwise the connection"
  echo "fails silently."
else
  echo "A page served over https cannot use a ws:// relay (mixed content): serve the page over http on the"
  echo "LAN, or use MODE=https."
fi
echo "Stop: ./test/nostr/relay.sh stop   Logs: docker logs $NAME   Persisted snapshots: docker exec $NAME cat /srv/snapshots.json"

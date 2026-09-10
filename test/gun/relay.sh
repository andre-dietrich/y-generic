#!/usr/bin/env bash
# Start a Gun relay for a classroom in docker and print what to enter.
#
#   ./test/gun/relay.sh                 # http://<LAN address>:8765/gun
#   MODE=https ./test/gun/relay.sh      # https://<LAN address>:8765/gun with a self-signed certificate
#   PORT=9000 IP=192.168.1.10 ./test/gun/relay.sh   # override port, and the detected address
#   ./test/gun/relay.sh stop            # stop and remove the container
#
# Runs the liascript/gundb image (built from Docker/gun/Dockerfile, pinned
# to the clients' Gun version) with --network host, and Gun with multicast
# and AXE off - one relay, alone, reached by an IPv4 address. The container
# detects its own LAN address (Docker/gun/entrypoint.sh) and, with
# MODE=https, generates a self-signed certificate for it on first start -
# so the same command works for anyone, without knowing their address
# upfront. Measured 2026-09-07 with two Node peers: live writes reach a
# subscriber over the LAN IPv4 address and over 127.0.0.1, but NOT over
# `localhost` (which resolves to the IPv6 ::1 on current systems), NOT
# through docker's port mapping (bridge + docker-proxy), and not reliably
# when a second Gun relay is reachable on the host or LAN (every relay
# multicasts on 233.255.255.255:8765 and they mesh). In each failing case
# the subscriber gets what existed before it subscribed and nothing written
# afterwards, with no error anywhere.
# The certificate and the relay's data (radata) live in the docker volume
# gun-relay-data, so a restart keeps them; the app itself is baked into the
# liascript/gundb image.
set -euo pipefail

NAME="${NAME:-gun-relay}"
PORT="${PORT:-8765}"
MODE="${MODE:-http}"
IMAGE="${IMAGE:-liascript/gundb:latest}"

if [ "${1:-}" = "stop" ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 && echo "$NAME stopped and removed" || echo "$NAME was not running"
  exit 0
fi
case "$MODE" in http|https) ;; *) echo "MODE must be http or https" >&2; exit 1 ;; esac

# --network host is a real host network stack only on Linux; on Docker
# Desktop (macOS/Windows) it's the VM's own network, so the address the
# container would detect is not reachable from other devices on the LAN.
case "$(uname -s 2>/dev/null || true)" in
  Linux) ;;
  *)
    echo "This needs Docker's --network host, which only gives the real LAN address on Linux"
    echo "(on macOS/Windows Docker Desktop it's an internal VM address, unreachable from other devices)."
    echo "Run Gun directly instead, no Docker:"
    echo
    echo "  npm install gun"
    echo "  node -e \"require('gun')({web:require('http').createServer().listen($PORT),multicast:false,axe:false})\""
    echo
    echo "Then enter http://<your LAN IP>:$PORT/gun as the relay (find the IP via ipconfig/ifconfig)."
    exit 0
    ;;
esac

docker rm -f "$NAME" >/dev/null 2>&1 || true

EXTRA_ARGS=()
[ -n "${IP:-}" ] && EXTRA_ARGS+=(-e "RELAY_IP=$IP")

docker run -d --name "$NAME" --network host -v gun-relay-data:/srv \
  -e PORT="$PORT" -e MODE="$MODE" "${EXTRA_ARGS[@]}" \
  "$IMAGE" >/dev/null

printf 'starting %s (first start pulls %s) ' "$NAME" "$IMAGE"
for _ in $(seq 1 90); do
  if curl -sk -o /dev/null "$MODE://localhost:$PORT/gun"; then echo; break; fi
  printf '.'; sleep 1
done
if ! curl -sk -o /dev/null "$MODE://localhost:$PORT/gun"; then
  echo; echo "relay did not come up; docker logs $NAME" >&2; exit 1
fi

echo
docker logs "$NAME" 2>/dev/null
echo "Same machine: $MODE://127.0.0.1:$PORT/gun - not 'localhost', which is IPv6 (::1) on current systems and loses Gun's live writes."
echo "Firewall: allow $PORT/tcp (e.g. sudo ufw allow $PORT/tcp)."
if [ "$MODE" != https ]; then
  echo "A page served over https cannot use an http relay (mixed content): serve the page over http on the LAN, or use MODE=https."
fi
echo "Stop: ./test/gun/relay.sh stop   Logs: docker logs $NAME"

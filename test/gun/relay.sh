#!/usr/bin/env bash
# Start a Gun relay for a classroom in docker and print what to enter.
#
#   ./test/gun/relay.sh                 # http://<LAN address>:8765/gun
#   MODE=https ./test/gun/relay.sh      # https://<LAN address>:8765/gun with a self-signed certificate
#   PORT=9000 IP=192.168.1.10 ./test/gun/relay.sh   # override port and address
#   ./test/gun/relay.sh stop            # stop and remove the container
#
# Pins the Gun version to the clients' 0.2020.1241, runs the container
# with --network host, and runs Gun with multicast and AXE off - one relay,
# alone, reached by an IPv4 address. Measured 2026-09-07 with two Node
# peers: live writes reach a subscriber over the LAN IPv4 address and over
# 127.0.0.1, but NOT over `localhost` (which resolves to the IPv6 ::1 on
# current systems), NOT through docker's port mapping (bridge +
# docker-proxy), and not reliably when a second Gun relay is reachable on
# the host or LAN (every relay multicasts on 233.255.255.255:8765 and they
# mesh). In each failing case the subscriber gets what existed before it
# subscribed and nothing written afterwards, with no error anywhere.
# Host networking is a Linux feature - on Docker Desktop (macOS/Windows)
# run the relay without docker: npm install gun, then
#   node -e "require('gun')({web:require('http').createServer().listen(8765),multicast:false,axe:false})"
# node_modules, the certificate and the relay's data (radata) live in the
# docker volume gun-relay-data, so a restart is quick and keeps the rooms.
set -euo pipefail

NAME="${NAME:-gun-relay}"
PORT="${PORT:-8765}"
MODE="${MODE:-http}"
GUN_VERSION="${GUN_VERSION:-0.2020.1241}"

if [ "${1:-}" = "stop" ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 && echo "$NAME stopped and removed" || echo "$NAME was not running"
  exit 0
fi
case "$MODE" in http|https) ;; *) echo "MODE must be http or https" >&2; exit 1 ;; esac

# The LAN address students will reach: the source address of the default
# route, else the first address that is not docker's own bridge.
if [ -z "${IP:-}" ]; then
  IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true)"
fi
if [ -z "${IP:-}" ]; then
  IP="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v -E '^(172\.1[7-9]|172\.2[0-9]|172\.3[01])\.' | grep -v '^$' | head -1 || true)"
fi
if [ -z "${IP:-}" ]; then
  IP="$(ipconfig getifaddr en0 2>/dev/null || true)"   # macOS
fi
[ -n "${IP:-}" ] || { echo "could not determine the LAN address; pass IP=..." >&2; exit 1; }

docker rm -f "$NAME" >/dev/null 2>&1 || true

# Inside the container: install the pinned gun once, write the relay (gun's
# examples/http.js with multicast and AXE off), make a certificate for
# https once (valid for this address and localhost), run it.
RELAY_JS='const fs=require("fs"),Gun=require("gun");const port=process.env.PORT||8765;const server=process.env.HTTPS_KEY?require("https").createServer({key:fs.readFileSync(process.env.HTTPS_KEY),cert:fs.readFileSync(process.env.HTTPS_CERT)},Gun.serve(__dirname)):require("http").createServer(Gun.serve(__dirname));Gun({web:server.listen(port),multicast:false,axe:false});console.log("Gun relay on port "+port+" with /gun (multicast off, axe off)")'
SETUP="[ -d node_modules/gun ] || npm install --no-audit --no-fund gun@$GUN_VERSION >/dev/null 2>&1; printf '%s' '$RELAY_JS' > relay.js"
if [ "$MODE" = https ]; then
  SETUP="$SETUP; [ -f cert-$IP.pem ] || (apk add --no-cache openssl >/dev/null 2>&1 && openssl req -x509 -newkey rsa:2048 -nodes -keyout key-$IP.pem -out cert-$IP.pem -days 3650 -subj '/CN=gun-relay' -addext 'subjectAltName=IP:$IP,DNS:localhost' >/dev/null 2>&1)"
  docker run -d --name "$NAME" --network host -v gun-relay-data:/srv -w /srv \
    -e PORT="$PORT" -e HTTPS_KEY="/srv/key-$IP.pem" -e HTTPS_CERT="/srv/cert-$IP.pem" \
    node:22-alpine sh -c "$SETUP; exec node relay.js" >/dev/null
else
  docker run -d --name "$NAME" --network host -v gun-relay-data:/srv -w /srv \
    -e PORT="$PORT" \
    node:22-alpine sh -c "$SETUP; exec node relay.js" >/dev/null
fi

printf 'starting %s (first start installs gun, ~30 s) ' "$NAME"
for _ in $(seq 1 90); do
  if curl -sk -o /dev/null "$MODE://localhost:$PORT/gun"; then echo; break; fi
  printf '.'; sleep 1
done
if ! curl -sk -o /dev/null "$MODE://localhost:$PORT/gun"; then
  echo; echo "relay did not come up; docker logs $NAME" >&2; exit 1
fi

echo
echo "Gun relay running. Enter as Gun relay server:"
echo
echo "    $MODE://$IP:$PORT/gun"
echo
echo "Same machine: $MODE://127.0.0.1:$PORT/gun - not 'localhost', which is IPv6 (::1) on current systems and loses Gun's live writes."
echo "Firewall: allow $PORT/tcp (e.g. sudo ufw allow $PORT/tcp)."
if [ "$MODE" = https ]; then
  echo "Self-signed certificate: every device must open https://$IP:$PORT/ once and accept the browser warning,"
  echo "otherwise its websocket to the relay is refused silently."
else
  echo "A page served over https cannot use an http relay (mixed content): serve the page over http on the LAN, or use MODE=https."
fi
echo "Stop: ./test/gun/relay.sh stop   Logs: docker logs $NAME"

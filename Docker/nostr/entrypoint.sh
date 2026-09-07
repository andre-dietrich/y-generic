#!/bin/sh
# Runs from /srv (the https certificate and snapshots.json - persisted
# replaceable/addressable events, see relay.js - land here; regular/
# ephemeral events stay in memory and are lost on restart) but executes
# the app baked into the image at /app.
#
# Detects the LAN address itself (via `ip route get`, the source address
# for the default route) unless RELAY_IP is already set - this only gives
# the real answer under --network host, i.e. on Linux; see test/gun/relay.sh
# (same reasoning applies here). With MODE=https, generates a self-signed
# certificate for that address on first start (kept in the volume, so a
# restart doesn't regenerate it).
set -eu
cd /srv

if [ -z "${RELAY_IP:-}" ]; then
  RELAY_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
fi
[ -n "$RELAY_IP" ] || RELAY_IP=127.0.0.1
export RELAY_IP

if [ "${MODE:-http}" = https ]; then
  export HTTPS_KEY="/srv/key-$RELAY_IP.pem"
  export HTTPS_CERT="/srv/cert-$RELAY_IP.pem"
  if [ ! -f "$HTTPS_KEY" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$HTTPS_KEY" -out "$HTTPS_CERT" \
      -days 3650 -subj '/CN=nostr-relay' -addext "subjectAltName=IP:$RELAY_IP,DNS:localhost"
  fi
fi

exec node /app/relay.js

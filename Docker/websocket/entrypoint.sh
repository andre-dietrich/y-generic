#!/bin/sh
# Runs from /srv (the data volume: the https certificate lands here) but
# executes the app baked into the image at /app.
#
# Everything a start needs happens in here, so a plain `docker run` is
# enough and test/websocket/relay.sh is only convenience:
#
#   - the LAN address is detected (via `ip route get`, the source address
#     for the default route) unless RELAY_IP is already set, and a docker
#     BRIDGE address is called out - that one is reachable from nowhere but
#     this host, and it is the quiet way a classroom fails;
#   - with MODE=https a self-signed certificate for that address is
#     generated on first start (kept in the volume, so a restart doesn't
#     regenerate it) and handed to the server through SSL_KEY/SSL_CERT,
#     which turn on https by themselves. The server's own --ssl is
#     deliberately not used: it writes a certificate whose subjectAltName is
#     DNS:localhost,IP:127.0.0.1,IP:0.0.0.0 and nothing else (its
#     ssl-utils.js), so every other device in the room - which reaches this
#     relay by its LAN address - would reject it;
#   - once the port actually answers, the address to enter is printed as the
#     last thing in the log, after the server's own banner.
set -eu
cd /srv

SERVER=/app/node_modules/edrys-websocket-server/src/server.js
PORT="${PORT:-1234}"

# A docker bridge hands out 172.16.0.0/12 on an interface called eth0.
# A LAN can legitimately use that range too, hence both conditions and a
# warning rather than a refusal. Only for an address we detected ourselves:
# an explicit RELAY_IP is the operator's word.
is_bridge_address() { # $1 = address, $2 = interface
  case "$2" in eth0) ;; *) return 1 ;; esac
  case "$1" in
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
    *) return 1 ;;
  esac
}

DETECTED=""
if [ -z "${RELAY_IP:-}" ]; then
  RELAY_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
  DETECTED=yes
fi
[ -n "$RELAY_IP" ] || RELAY_IP=127.0.0.1
export RELAY_IP

if [ -n "$DETECTED" ]; then
  IFACE="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')"
  if is_bridge_address "$RELAY_IP" "${IFACE:-}"; then
    echo
    echo "!! $RELAY_IP (on ${IFACE:-?}) is a docker bridge address, not this machine's"
    echo "!! LAN address - no other device can reach the relay there, and with MODE=https"
    echo "!! the certificate would be issued for it."
    echo "!!"
    echo "!! Start the container with --network host (Linux), or name the address"
    echo "!! yourself: -e RELAY_IP=<your LAN address>."
    echo
  fi
fi

if [ "${MODE:-http}" = https ]; then
  export SSL_KEY="/srv/key-$RELAY_IP.pem"
  export SSL_CERT="/srv/cert-$RELAY_IP.pem"
  if [ ! -f "$SSL_KEY" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "$SSL_KEY" -out "$SSL_CERT" \
      -days 3650 -subj '/CN=websocket-relay' \
      -addext "subjectAltName=IP:$RELAY_IP,IP:127.0.0.1,DNS:localhost" 2>/dev/null
  fi
fi

# SSL_KEY/SSL_CERT switch the server to https whether they come from
# MODE=https above or from the operator (a real certificate, mounted).
if [ -n "${SSL_KEY:-}" ] && [ -n "${SSL_CERT:-}" ]; then
  SCHEME=wss
  PAGE="https://$RELAY_IP:$PORT"
else
  SCHEME=ws
  PAGE="http://$RELAY_IP:$PORT"
fi

# Waits for the port to answer and then prints the address, so the log ends
# with what to enter rather than with the server's interface listing. In a
# subshell, so `exec` below can keep the server as PID 1 and `docker stop`
# reaches it directly.
(
  if node -e '
    const net = require("net")
    const port = Number(process.argv[1])
    let tries = 0
    const probe = () => {
      const s = net.connect(port, "127.0.0.1")
      s.on("connect", () => { s.destroy(); process.exit(0) })
      s.on("error", () => {
        s.destroy()
        if (++tries > 60) process.exit(1)
        setTimeout(probe, 500)
      })
    }
    probe()
  ' "$PORT"; then
    echo
    echo "y-websocket relay ready on"
    echo
    echo "    $SCHEME://$RELAY_IP:$PORT"
    echo
    echo "Enter that as the server URL in the WebSocket provider, with"
    echo "verifyUpdates: false (see src/providers/websocket/README.md)."
    echo
    if [ "${MODE:-http}" = https ]; then
      echo "Self-signed certificate: open $PAGE/ once in a browser on this and every"
      echo "other device and accept the warning, before using the address above -"
      echo "otherwise the connection fails silently, a browser shows no certificate"
      echo "dialog for a websocket."
      echo
    fi
  else
    echo
    echo "!! the server did not open port $PORT within 30 s - see the log above"
    echo
  fi
) &

exec node "$SERVER" --host=0.0.0.0 --port="$PORT"

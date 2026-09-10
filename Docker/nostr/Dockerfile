# Classroom Nostr relay - minimal NIP-01 (EVENT/REQ/CLOSE/EOSE, no signature
# verification - see relay.js). Regular/ephemeral events are in-memory
# only; replaceable and addressable events (kind >=10000, used by
# NostrTransport's `persistent` mode for Yjs snapshots) are persisted to
# /srv/snapshots.json. Build and push:
#   docker build -t liascript/nostr-relay:latest Docker/nostr
#   docker push liascript/nostr-relay:latest
# Runs with --network host (Linux only - see test/gun/relay.sh, same
# reasoning applies here), so the entrypoint detects the LAN address itself
# via `ip route get`. Run with -e MODE=https to get a self-signed
# certificate generated on first start.
FROM node:22-alpine

RUN apk add --no-cache openssl iproute2
WORKDIR /app
RUN npm install --no-audit --no-fund ws@8
COPY relay.js entrypoint.sh ./
RUN chmod +x entrypoint.sh

# /srv holds the https certificate and snapshots.json (persisted
# replaceable/addressable events - see relay.js; regular/ephemeral events
# stay in memory and are lost on restart) - kept in the nostr-relay-data
# volume across restarts. The app itself lives in /app, baked into the image.
VOLUME /srv
ENV PORT=8766
EXPOSE 8766
ENTRYPOINT ["/app/entrypoint.sh"]

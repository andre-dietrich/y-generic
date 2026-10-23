# Classroom y-websocket relay: the edrys-websocket-server (a y-websocket
# server with an extra /stream path for video), pinned to a commit. Build
# and push:
#   docker build -t liascript/websocket-relay:latest Docker/websocket
#   docker push liascript/websocket-relay:latest
# Runs with --network host (Linux only - see test/websocket/relay.sh), so the
# entrypoint detects the LAN address itself via `ip route get`. Run with
# -e MODE=https to get a self-signed certificate generated on first start.
#
# Two stages because npm needs `git` to install from a repository and the
# server is not on npm - git stays in the build stage, out of the image.
FROM node:22-alpine AS build
# github.com/edrys-labs/edrys-websocket-server, main as of 2026-09-24
ARG SERVER_REF=b501aae29ec420df56f9657bce0c6fa55abfcc8f
RUN apk add --no-cache git
WORKDIR /app
# --omit=optional keeps y-leveldb out: it pulls leveldown, which has no
# prebuilt binary for musl and would need a native toolchain in here for a
# persistence layer this image does not use.
#
# ws@6 is then NOT optional any more but required, because it is one of the
# dependencies that flag drops - and it must stay on 6: the server does
# `import WebSocket from 'ws'` and `new WebSocket.Server(...)`, and ws@8
# resolves an ESM import through its wrapper.mjs, whose default export is
# the bare WebSocket class with no .Server ("WebSocket.Server is not a
# constructor"). 6.2.6 is the last of that line. yjs is the server's peer
# dependency, pinned here to the major the clients use.
RUN npm install --no-audit --no-fund --omit=optional \
      "github:edrys-labs/edrys-websocket-server#${SERVER_REF}" ws@6.2.6 yjs@13

FROM node:22-alpine
RUN apk add --no-cache openssl iproute2
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# /srv is data only (the https certificate) - kept in the
# websocket-relay-data volume across restarts. The app itself lives in
# /app, baked into the image, so it doesn't depend on what's already in
# the volume. The document is NOT persisted: after a restart the clients
# refill the relay's empty copy (test/dummy/e2e-edrys-ws.ts, check 5).
VOLUME /srv
ENV PORT=1234
EXPOSE 1234
ENTRYPOINT ["/app/entrypoint.sh"]

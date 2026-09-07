# Classroom Gun relay, pinned to the clients' gun version. Build and push:
#   docker build -t liascript/gundb:latest Docker/gun
#   docker push liascript/gundb:latest
# Runs with --network host (Linux only - see test/gun/relay.sh), so the
# entrypoint detects the LAN address itself via `ip route get`. Run with
# -e MODE=https to get a self-signed certificate generated on first start.
FROM node:22-alpine
ARG GUN_VERSION=0.2020.1241

RUN apk add --no-cache openssl iproute2
WORKDIR /app
RUN npm install --no-audit --no-fund gun@${GUN_VERSION}
COPY relay.js entrypoint.sh ./
RUN chmod +x entrypoint.sh

# /srv is data only (https certificate, gun's radata) - kept in the
# gun-relay-data volume across restarts. The app itself lives in /app,
# baked into the image, so it doesn't depend on what's already in the volume.
VOLUME /srv
ENV PORT=8765
EXPOSE 8765
ENTRYPOINT ["/app/entrypoint.sh"]

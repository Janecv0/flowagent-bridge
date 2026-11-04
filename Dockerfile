# No Azure CLI in the image: in production the engine's `az` calls are answered by bin/az,
# which fetches On-Behalf-Of tokens from the bridge. That also drops the ~1 GB of Python the
# CLI used to bring along.
FROM node:24.16.0-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bridge.mjs launch.mjs ./
COPY bin/ ./bin/
COPY vendor/ ./vendor/
# The engine runs `az` and `xdg-open` by name through PATH, so the stand-ins must be
# executable regardless of the permissions the build context happened to carry.
RUN chmod 755 bin/az bin/xdg-open
# Routes the engine's connection-management tokens through bin/az (see the script). Fails the
# build if a re-vendored engine no longer contains the line it patches.
COPY scripts/patch-engine.mjs ./scripts/
RUN node scripts/patch-engine.mjs vendor/mcp.mjs

ENV NODE_ENV=production
EXPOSE 8791

# Runs as root because the per-user directories under USERS_ROOT (default /data/pa-users)
# are created at runtime, and a mounted volume there is root-owned. Nothing in the container
# is reachable except the bridge's own authenticated HTTP port.
CMD ["node", "bridge.mjs"]

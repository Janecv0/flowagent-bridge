# Debian-based rather than the node:*-alpine used elsewhere in this project: the Azure
# CLI's supported install path is Microsoft's apt script, and several of its pinned
# Python dependencies ship no musl wheels, so Alpine forces a slow from-source build
# needing a full toolchain. The `az` binary is a hard runtime requirement here — the
# FlowAgent engine shells out to it for every token — so this base is not negotiable.
FROM node:24.16.0-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl apt-transport-https gnupg lsb-release \
    && curl -sL https://aka.ms/InstallAzureCLIDeb | bash \
    && apt-get purge -y curl gnupg lsb-release apt-transport-https \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bridge.mjs launch.mjs ./
COPY vendor/ ./vendor/

ENV NODE_ENV=production
EXPOSE 8791

# Runs as root because the Railway Volume is mounted root-owned and the per-user token
# directories are created at runtime. Nothing in the container is reachable except the
# bridge's own authenticated HTTP port, and no public domain is attached to the service.
CMD ["node", "bridge.mjs"]

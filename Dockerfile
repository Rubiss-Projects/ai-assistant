# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json patch-deps.cjs ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

# Relocate the complete native Codex bundle to a stable system path. The CLI
# resolves Bubblewrap, zsh, rg, and its code-mode host relative to this layout;
# copying only bin/codex makes every shared-mode sandbox launch fail.
RUN node -e "const fs=require('fs');const path=require('path');const arch=process.arch==='arm64'?'arm64':'x64';const triple=arch==='arm64'?'aarch64-unknown-linux-musl':'x86_64-unknown-linux-musl';const pkg=require.resolve('@openai/codex-linux-'+arch+'/package.json');fs.cpSync(path.join(path.dirname(pkg),'vendor',triple),'/app/codex-runtime',{recursive:true})" \
    && chmod 0555 /app/codex-runtime/bin/* /app/codex-runtime/codex-path/* /app/codex-runtime/codex-resources/bwrap /app/codex-runtime/codex-resources/zsh/bin/zsh

FROM node:20-bookworm-slim AS runtime

ARG VERSION=dev
ARG REVISION=unknown
ARG OPENCODE_VERSION=1.18.29
LABEL org.opencontainers.image.title="AI Assistant" \
      org.opencontainers.image.description="Sandboxed Discord AI assistant" \
      org.opencontainers.image.source="https://github.com/Rubiss-Projects/ai-assistant" \
      org.opencontainers.image.version="$VERSION" \
      org.opencontainers.image.revision="$REVISION"

# These are useful agent tools. Additional tools can be added in a derived image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force \
    && groupadd --gid 10001 assistant \
    && useradd --uid 10001 --gid assistant --home-dir /data --create-home assistant

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/codex-runtime /usr/local/lib/codex
COPY scripts/container-entrypoint.sh ./container-entrypoint.sh
RUN chmod 0555 /app/container-entrypoint.sh

ENV NODE_ENV=production \
    HOME=/data \
    AI_ASSISTANT_CONFIG_DIR=/data \
    PATH=/usr/local/lib/codex/bin:/app/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
    CODEX_EXECUTABLE_PATH=/usr/local/lib/codex/bin/codex

USER 10001:10001
WORKDIR /data
ENTRYPOINT ["/app/container-entrypoint.sh"]
CMD ["start"]

FROM docker:28-cli AS docker_cli

FROM node:22-alpine AS mcp_builder

ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /app
COPY package.json package-lock.json tsconfig.mcp.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --registry="${NPM_REGISTRY}"
COPY server/mcp ./server/mcp
COPY server/lib/jwt.js ./server/lib/jwt.js
COPY scripts/test-mcp-e2e.mjs ./scripts/test-mcp-e2e.mjs
RUN npm run build:mcp

FROM node:22-alpine

ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG APK_REPOSITORY=https://mirrors.aliyun.com/alpine

COPY --from=docker_cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker_cli /usr/local/libexec/docker /usr/local/libexec/docker

WORKDIR /app
COPY package.json package-lock.json ./
RUN sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${APK_REPOSITORY}#g" /etc/apk/repositories \
    && apk add --no-cache mysql-client postgresql-client
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --registry="${NPM_REGISTRY}"

ARG BUILD_REVISION=development
ARG BUILD_CREATED=unknown
LABEL org.opencontainers.image.title="Cube Console" \
      org.opencontainers.image.revision="${BUILD_REVISION}" \
      org.opencontainers.image.created="${BUILD_CREATED}"

COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY --from=mcp_builder /app/dist ./dist

ENV NODE_ENV=production PORT=4010
EXPOSE 4010

HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD wget -q -O - http://127.0.0.1:4010/healthz >/dev/null || exit 1
CMD ["sh", "-ec", "node scripts/render-openapi.mjs && exec node server/server.js"]

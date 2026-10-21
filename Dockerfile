# syntax=docker/dockerfile:1

# Dependencias de producción. sharp descarga su binario precompilado para linux-x64.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    XDG_CACHE_HOME=/tmp

# rsvg-convert genera el avatar/OG; las fuentes evitan texto vacío en las imágenes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      fontconfig \
      fonts-dejavu-core \
      librsvg2-bin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ARG APP_VERSION=1.1.0
LABEL org.opencontainers.image.title="link-in-bio" \
      org.opencontainers.image.description="Página de enlaces con panel de administración, login único y estadísticas propias." \
      org.opencontainers.image.source="https://github.com/KannemanM/link-in-bio" \
      org.opencontainers.image.url="https://github.com/KannemanM/link-in-bio" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${APP_VERSION}"

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.mjs ./
COPY lib ./lib
COPY templates ./templates
COPY public ./public
COPY tools ./tools
COPY links.json ./

# El volumen /data se inicializa con el usuario node (UID 1000).
RUN mkdir -p /data \
    && chown node:node /data

USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]

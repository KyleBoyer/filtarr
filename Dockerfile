FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.30.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 FILTARR_DB=/config/filtarr.db FILTARR_WEB_DIST=/app/packages/web/dist
COPY --from=build /app /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /config && chown node:node /config
# Starts as root only to fix /config ownership, then drops to PUID:PGID (see docker-entrypoint.sh).
ENV PUID=1000 PGID=1000 HOME=/tmp
VOLUME /config
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "packages/server/dist/main.js"]

# syntax=docker/dockerfile:1
# --- build stage: full install + web bundle ---
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @archsync/web build

# --- runtime stage: same image trimmed to what the server needs ---
# The server runs from TypeScript via tsx (a devDependency), so the full
# workspace node_modules stay; this is a deliberate MVP trade-off documented
# in docs/deploy.md. Only the data volume is not baked into the image.
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4310 \
    DATABASE_PATH=/data/archsync-state.json
VOLUME /data
COPY --from=build /app /app
EXPOSE 4310
CMD ["pnpm", "exec", "tsx", "apps/server/src/index.ts"]

# Single-image build for Coolify — use with Base Directory = Web-App
# If building from repository root, use the Dockerfile at the repo root instead.

FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package*.json ./
# --include=dev ensures TypeScript/Vite are available even when Coolify
# sets NODE_ENV=production at build time (warning in deploy logs)
RUN npm ci --include=dev
COPY client ./
RUN VITE_BACKEND_URL="" npm run build

FROM node:20-alpine AS server-build
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --include=dev
COPY server ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# wget is not guaranteed in node:alpine minimal — install for HEALTHCHECK
RUN apk add --no-cache wget
COPY --from=server-build /app/server/dist ./server/dist
COPY --from=server-build /app/server/package*.json ./server/
COPY --from=server-build /app/server/node_modules ./server/node_modules
COPY --from=client-build /app/client/dist ./server/dist/client

EXPOSE 3001
# Coolify sets PORT dynamically (3000 in this deployment); try PORT then fall back to 3001/3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD sh -c 'wget -qO- http://127.0.0.1:${PORT:-3001}/api/health || wget -qO- http://127.0.0.1:3001/api/health || wget -qO- http://127.0.0.1:3000/api/health || exit 1'

WORKDIR /app/server
CMD ["node", "dist/index.js"]

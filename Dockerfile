# Single-image build for Coolify: React admin (Vite) + Express + Socket.IO
# Build context: repository root

# Stage 1 — build React admin
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY Web-App/client/package*.json ./
# --include=dev ensures TypeScript/Vite are available even when Coolify
# sets NODE_ENV=production at build time (warning in deploy logs)
RUN npm ci --include=dev
COPY Web-App/client ./
# Empty VITE_BACKEND_URL -> SocketContext falls back to window.location.origin (same-origin on Coolify)
RUN VITE_BACKEND_URL="" npm run build

# Stage 2 — build Express server
FROM node:20-alpine AS server-build
WORKDIR /app/server
COPY Web-App/server/package*.json ./
RUN npm ci --include=dev
COPY Web-App/server ./
RUN npm run build

# Stage 3 — runtime (single Coolify resource)
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# Server dist + deps
COPY --from=server-build /app/server/dist ./server/dist
COPY --from=server-build /app/server/package*.json ./server/
COPY --from=server-build /app/server/node_modules ./server/node_modules
# Client dist -> served by Express at / (server/src/index.ts serves dist/client)
COPY --from=client-build /app/client/dist ./server/dist/client

EXPOSE 3001
# Coolify injects $PORT; server respects process.env.PORT || 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3001}/api/health || exit 1

WORKDIR /app/server
CMD ["node", "dist/index.js"]

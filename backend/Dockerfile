# syntax=docker/dockerfile:1
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY backend/package.json backend/
COPY gateway/package.json gateway/
COPY web/package.json web/
RUN npm ci
COPY backend backend
RUN npm run build -w backend

FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY gateway/package.json gateway/
COPY web/package.json web/
RUN npm ci --omit=dev -w backend

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
# Runtime needs only node; the npm/yarn bundled in the base image only adds CVEs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=deps --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/backend/dist backend/dist
COPY --chown=node:node backend/package.json backend/
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "backend/dist/server.js"]

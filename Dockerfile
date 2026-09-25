# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html style.css ./
COPY build ./build
COPY server ./server
COPY scripts ./scripts
COPY src ./src
COPY public ./public
COPY config ./config
RUN npm run build:container

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json LICENSE THIRD_PARTY_NOTICES.md ./
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src ./src
COPY scripts ./scripts
COPY config ./config
RUN mkdir -p .gev-cache .gev-logs && chown node:node .gev-cache .gev-logs
USER node
EXPOSE 4173
CMD ["node", "server/standalone/production.mjs"]

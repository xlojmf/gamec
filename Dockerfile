# syntax=docker/dockerfile:1

# ---- build stage -----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# install deps first for layer caching (allowScripts in package.json permits
# esbuild's postinstall, which the vite build requires)
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ARG VITE_GAME_SERVER_URL=""
ARG VITE_GAME_SERVER_PORT=8000
ENV VITE_GAME_SERVER_URL=$VITE_GAME_SERVER_URL
ENV VITE_GAME_SERVER_PORT=$VITE_GAME_SERVER_PORT
RUN npm run build && npm run build:game

# ---- runtime stage ----------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# the SSR bundle externalizes runtime deps (react, h3-v2, …) — install prod deps
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["node", "server.mjs"]

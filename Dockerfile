# One container, one process (2.1). GPU steps run on a native Mac worker outside
# this container (D5) — nothing GPU-related belongs in here.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY app ./app
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=4400 \
    LIBRARY_DIR=/app/library
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Node strips the server's types itself; only the SPA needs a build.
COPY app/server ./app/server
COPY --from=build /app/dist/web ./dist/web
EXPOSE 4400
CMD ["node", "--disable-warning=ExperimentalWarning", "app/server/index.ts"]

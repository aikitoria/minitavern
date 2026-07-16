FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY shared shared
COPY client client
RUN npm run build -w client

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    CLIENT_DIST=/app/client/dist \
    PORT=5487
COPY package.json package-lock.json ./
COPY shared shared
COPY server server
COPY client/package.json client/
RUN npm ci --omit=dev
COPY --from=build /app/client/dist client/dist
VOLUME /data
EXPOSE 5487
CMD ["node", "server/src/index.ts"]

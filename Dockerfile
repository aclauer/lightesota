# Build and run the Lightesota server with the web app baked in.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 LIGHTESOTA_DATA=/data
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/shared ./shared
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/patterns ./patterns
RUN npm ci --omit=dev
VOLUME /data
EXPOSE 8787/tcp 6454/udp
CMD ["node", "server/dist/server/src/index.js"]

FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY tsconfig.json ./

RUN mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production
EXPOSE 8080

USER node

CMD ["node", "src/server.ts"]

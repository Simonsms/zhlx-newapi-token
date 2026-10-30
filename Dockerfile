# 阶段一：构建管理前端（web/）
FROM node:24-alpine AS web

WORKDIR /web

COPY web/package.json web/package-lock.json ./
RUN npm ci --no-fund --no-audit

COPY web/ ./
RUN npm run build

# 阶段二：运行服务
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

COPY src ./src
COPY tsconfig.json ./
# 前端构建产物由 src/static.ts 从 ../web/dist 读取
COPY --from=web /web/dist ./web/dist

RUN mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production
EXPOSE 8080

USER node

CMD ["node", "src/server.ts"]

FROM node:26-slim

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    DATA_DIR=/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/

# 容器内非 root 运行；卷挂载后 /data 属主由宿主机决定，见 README。
RUN mkdir -p /data/images && chown -R node:node /data /app
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "src/server.mjs"]

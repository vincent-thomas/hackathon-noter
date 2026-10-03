FROM oven/bun:1-alpine
WORKDIR /app
COPY server.ts index.html ./
EXPOSE 3000
CMD ["bun", "server.ts"]

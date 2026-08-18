# oven/bun:1.3.9-alpine
FROM oven/bun@sha256:9028ee7a60a04777190f0c3129ce49c73384d3fc918f3e5c75f5af188e431981 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY tsconfig.json tsconfig.build.json ./
RUN bun run build

# node:24-alpine
FROM node@sha256:bde0dae02f2b12d2bce5ee72b2432f0e511767b7b2dc4dd3b064df11ae422fee AS runtime
LABEL org.opencontainers.image.source="https://github.com/bosun-sh/crew-node" \
      org.opencontainers.image.description="Customer-installed execution boundary for Crew Cloud" \
      org.opencontainers.image.licenses="MIT"
RUN apk add --no-cache git patch tini
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY package.json ./
RUN addgroup -S crew && adduser -S crew -G crew && mkdir -p /workspace /data/audit /data/state && chown -R crew:crew /workspace /data
USER crew
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e 'const port=process.env.CREW_PORT||"4321"; fetch(`http://127.0.0.1:${port}/readyz`).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]

# oven/bun:1.3.9-alpine
FROM oven/bun@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY tsconfig.json tsconfig.build.json ./
RUN bun run build

# node:24-alpine
FROM node@sha256:f5d1cc40abc10c2843339a2134d07817cf33c405cb16bfd052b0ed790254c3a3 AS runtime
LABEL org.opencontainers.image.source="https://github.com/bosun-sh/crew-node" \
      org.opencontainers.image.description="Customer-installed execution boundary for Crew Cloud" \
      org.opencontainers.image.licenses="MIT"
RUN apt-get update \
    && apt-get install -y --no-install-recommends git patch tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY package.json ./
RUN groupadd --system crew \
    && useradd --system --gid crew --no-create-home crew \
    && mkdir -p /workspace /data/audit /data/state \
    && chown -R crew:crew /workspace /data
USER crew
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e 'const port=process.env.CREW_PORT||"4321"; fetch(`http://127.0.0.1:${port}/readyz`).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]

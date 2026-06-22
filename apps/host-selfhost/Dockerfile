# Self-hosted Executor — single container, no external services.
# Build context is the REPO ROOT (the bun workspace install needs every member):
#   docker build -f apps/host-selfhost/Dockerfile -t executor-selfhost .
#
# Runtime needs nothing but this container + a volume for the data dir:
#   docker run -p 4788:4788 -e BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
#     -e EXECUTOR_BOOTSTRAP_ADMIN_EMAIL=you@example.com \
#     -e EXECUTOR_BOOTSTRAP_ADMIN_PASSWORD=... \
#     -e EXECUTOR_WEB_BASE_URL=https://your.domain \
#     -v executor-data:/data executor-selfhost
#
# SQLite (libSQL, file:/data/...) lives in /data, QuickJS + MCP run in-process —
# so there's no postgres/worker/proxy to orchestrate.

# ── Production deps: installs only what the runtime image needs ─────────────
FROM oven/bun:1 AS prod-deps
WORKDIR /app
COPY . .
# This stage is independent from the SPA build stage, so BuildKit can run the
# slow production install in parallel with the dev install and Vite build.
# --ignore-scripts: the root `prepare` hook runs a dev-only tool
# (effect-language-service); runtime deps are prebuilt JS with no postinstall.
RUN bun install --frozen-lockfile --production --ignore-scripts --filter @executor-js/host-selfhost \
  && find node_modules/.bun -maxdepth 1 -name '*linux-x64-musl*' -exec rm -rf {} + \
  && rm -rf \
    node_modules/.bun/@ant-design+* \
    node_modules/.bun/@base-ui+* \
    node_modules/.bun/@cloudflare+workers-types@* \
    node_modules/.bun/@electric-sql+pglite@* \
    node_modules/.bun/@emotion+react@* \
    node_modules/.bun/@emoji-mart+* \
    node_modules/.bun/@esbuild+* \
    node_modules/.bun/@floating-ui+react@* \
    node_modules/.bun/@dnd-kit+* \
    node_modules/.bun/@hookform+* \
    node_modules/.bun/@lobehub+* \
    node_modules/.bun/@mermaid-js+* \
    node_modules/.bun/@pierre+diffs@* \
    node_modules/.bun/@pierre+theme@* \
    node_modules/.bun/@primer+octicons@* \
    node_modules/.bun/@rc-component+* \
    node_modules/.bun/@rolldown+binding-* \
    node_modules/.bun/@reduxjs+* \
    node_modules/.bun/@shikijs+* \
    node_modules/.bun/@splinetool+* \
    node_modules/.bun/@tanstack+start-plugin-core@* \
    node_modules/.bun/@tanstack+react-router@* \
    node_modules/.bun/@tanstack+router-core@* \
    node_modules/.bun/@types+* \
    node_modules/.bun/ahooks@* \
    node_modules/.bun/antd@* \
    node_modules/.bun/better-sqlite3@* \
    node_modules/.bun/bun-types@* \
    node_modules/.bun/caniuse-lite@* \
    node_modules/.bun/chroma-js@* \
    node_modules/.bun/cytoscape*@* \
    node_modules/.bun/d3@* \
    node_modules/.bun/date-fns*@* \
    node_modules/.bun/drizzle-kit@* \
    node_modules/.bun/dompurify@* \
    node_modules/.bun/emoji-mart@* \
    node_modules/.bun/framer-motion@* \
    node_modules/.bun/jiti@* \
    node_modules/.bun/katex@* \
    node_modules/.bun/layout-base@* \
    node_modules/.bun/leva@* \
    node_modules/.bun/lightningcss-* \
    node_modules/.bun/lit-html@* \
    node_modules/.bun/lucide-react@* \
    node_modules/.bun/mermaid@* \
    node_modules/.bun/motion@* \
    node_modules/.bun/motion-* \
    node_modules/.bun/polished@* \
    node_modules/.bun/prettier@* \
    node_modules/.bun/react-day-picker@* \
    node_modules/.bun/react-hook-form@* \
    node_modules/.bun/react@* \
    node_modules/.bun/react-dom@* \
    node_modules/.bun/react-dropzone@* \
    node_modules/.bun/recharts@* \
    node_modules/.bun/rolldown@* \
    node_modules/.bun/shiki@* \
    node_modules/.bun/solid-js@* \
    node_modules/.bun/source-map@* \
    node_modules/.bun/tailwind-merge@* \
    node_modules/.bun/tsx@* \
    node_modules/.bun/@upsetjs+venn.js@* \
    node_modules/.bun/victory-vendor@* \
    node_modules/.bun/virtua@* \
    node_modules/.bun/typeorm@* \
    node_modules/.bun/vite@* \
    node_modules/.bun/vitest@* \
  && find node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.ts' -o -name '*.tsx' -o -name '*.md' -o -name '*.markdown' \) -delete \
  && find node_modules -type d \( -iname test -o -iname tests -o -iname __tests__ -o -iname fixtures -o -iname fixture -o -iname examples \) -prune -exec rm -rf {} + \
  && find packages apps/host-selfhost -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.md' -o -name '*.markdown' \) -delete \
  && rm -rf \
    packages/app \
    packages/react \
    packages/plugins/*/fixtures \
    packages/plugins/*/src/react \
    packages/plugins/*/src/**/__snapshots__ \
    packages/plugins/*/test \
    packages/plugins/*/testing \
    packages/*/*/CHANGELOG.md \
    packages/*/*/tsconfig.json \
    packages/*/*/tsup.config.ts \
    packages/*/*/vitest.config.ts \
    packages/plugins/*/vitest.config.ts \
    apps/host-selfhost/CHANGELOG.md \
    apps/host-selfhost/Dockerfile \
    apps/host-selfhost/docker-compose.yml \
    apps/host-selfhost/scripts \
    apps/host-selfhost/vitest.config.ts \
    apps/host-selfhost/web \
    apps/host-selfhost/tsconfig.json \
    apps/host-selfhost/tsr.routes.ts \
    apps/host-selfhost/vite.config.ts

# ── Build stage: install the workspace + build the SPA ──────────────────────
FROM oven/bun:1 AS build
WORKDIR /app
COPY . .
# Full install (dev deps included, vite/turbo/plugins are needed to build).
RUN bun install --frozen-lockfile
# Builds @executor-js/vite-plugin (via turbo) then the self-host SPA into
# apps/host-selfhost/dist.
RUN cd apps/host-selfhost && bun run build

# ── Runtime stage: serve the built app under Bun ────────────────────────────
FROM gcr.io/distroless/cc-debian12 AS runtime
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/RhysSullivan/executor" \
      org.opencontainers.image.description="Single-container self-hosted Executor" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    EXECUTOR_HOST=0.0.0.0 \
    PORT=4788 \
    EXECUTOR_DATA_DIR=/data
COPY --from=prod-deps /usr/local/bin/bun /usr/local/bin/bun
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/packages/core/api /app/packages/core/api
COPY --from=prod-deps /app/packages/core/config /app/packages/core/config
COPY --from=prod-deps /app/packages/core/execution /app/packages/core/execution
COPY --from=prod-deps /app/packages/core/fumadb /app/packages/core/fumadb
COPY --from=prod-deps /app/packages/core/sdk /app/packages/core/sdk
COPY --from=prod-deps /app/packages/hosts/mcp /app/packages/hosts/mcp
COPY --from=prod-deps /app/packages/kernel/core /app/packages/kernel/core
COPY --from=prod-deps /app/packages/kernel/runtime-quickjs /app/packages/kernel/runtime-quickjs
COPY --from=prod-deps /app/packages/plugins/encrypted-secrets /app/packages/plugins/encrypted-secrets
COPY --from=prod-deps /app/packages/plugins/google /app/packages/plugins/google
COPY --from=prod-deps /app/packages/plugins/graphql /app/packages/plugins/graphql
COPY --from=prod-deps /app/packages/plugins/mcp /app/packages/plugins/mcp
COPY --from=prod-deps /app/packages/plugins/microsoft /app/packages/plugins/microsoft
COPY --from=prod-deps /app/packages/plugins/openapi /app/packages/plugins/openapi
COPY --from=prod-deps /app/apps/host-selfhost /app/apps/host-selfhost
COPY --from=build /app/apps/host-selfhost/dist /app/apps/host-selfhost/dist
WORKDIR /app/apps/host-selfhost
VOLUME ["/data"]
EXPOSE 4788
# Readiness probe against the public /api/health endpoint (a trivial DB ping).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD bun -e "fetch('http://127.0.0.1:4788/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# serve.ts binds the Effect AppLayer (API + /mcp + /api/auth + /docs) and serves
# the built SPA from ./dist — one process.
CMD ["bun", "run", "src/serve.ts"]

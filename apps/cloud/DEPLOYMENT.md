# Executor Cloud production deployment

Executor Cloud is the B2B SaaS surface for Executor: Cloudflare Worker + Durable Objects, Postgres via Hyperdrive, WorkOS AuthKit/Organizations, Autumn billing, Sentry/Axiom/PostHog observability, and the MCP endpoint.

## Production resources

Provision these before the first production deploy:

- **Cloudflare**
  - Worker name: `executor-cloud`
  - Route/custom domain: `executor.sh`
  - Hyperdrive binding: `HYPERDRIVE`
  - Durable Object binding: `MCP_SESSION`
  - Service binding: `MARKETING` -> `executor-marketing`
  - API token with Workers deploy permissions
- **Postgres**
  - Production database reachable from Cloudflare Hyperdrive
  - Migration URL stored only in GitHub as `PRODUCTION_DATABASE_URL`
  - Runtime requests should prefer the Hyperdrive binding, not direct `DATABASE_URL`
- **WorkOS**
  - AuthKit application and callback URL: `https://executor.sh/api/auth/callback`
  - Organizations enabled
  - Roles configured at least for `admin` and `member`
- **Autumn**
  - Products/features from `apps/cloud/autumn.config.ts`
  - Secret key available to the Worker
- **Observability**
  - Sentry DSN for Worker and browser tunnel
  - Axiom token/dataset/traces endpoint for OTEL
  - PostHog public key/host for browser analytics

## GitHub environment secrets

Create a GitHub Environment named `production` and add:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `PRODUCTION_DATABASE_URL`

Recommended: require approval on the `production` environment.

## Cloudflare Worker secrets

Set these with `wrangler secret put` or the Cloudflare dashboard:

```bash
cd apps/cloud
wrangler secret put WORKOS_API_KEY
wrangler secret put WORKOS_CLIENT_ID
wrangler secret put WORKOS_COOKIE_PASSWORD
wrangler secret put AUTUMN_SECRET_KEY
wrangler secret put SENTRY_DSN
wrangler secret put AXIOM_TOKEN
wrangler secret put AXIOM_DATASET
wrangler secret put AXIOM_TRACES_URL
wrangler secret put MCP_AUTHKIT_DOMAIN
wrangler secret put MCP_RESOURCE_ORIGIN
wrangler secret put READINESS_TOKEN
```

Non-secret public vars live in `apps/cloud/wrangler.jsonc` under `vars`.

## Deployment flow

The production workflow is `.github/workflows/deploy-cloud.yml`.

On every push to `main` that touches cloud/package files, it:

1. Installs Bun dependencies.
2. Runs format/lint checks.
3. Typechecks `apps/cloud`.
4. Runs `apps/cloud` tests.
5. Builds the Cloudflare Worker.
6. Runs Drizzle migrations with `PRODUCTION_DATABASE_URL`.
7. Deploys with Wrangler.
8. Verifies `https://executor.sh/healthz`.

Manual deploys can be started from GitHub Actions. The manual input `run_migrations=false` can be used for a redeploy/rollback where the database is already at the target schema.

## Local smoke checks

```bash
bun install
cd apps/cloud
bun run typecheck
bun run test
bun run build
```

Never use `bun test`; repo tests are Vitest-based.

## Runtime health endpoints

- `GET /healthz` — public, cheap, no dependency checks. Returns service/version/commit.
- `GET /readyz` — dependency-aware readiness. Checks required SaaS secrets and Postgres connectivity. If `READINESS_TOKEN` is set, call it with:

```bash
curl -H "x-readiness-token: $READINESS_TOKEN" https://executor.sh/readyz
```

Use `/healthz` for post-deploy smoke checks and `/readyz` for internal monitors.

## First production deploy checklist

- [ ] Cloudflare Worker route and service binding exist.
- [ ] Hyperdrive binding id in `apps/cloud/wrangler.jsonc` points at production Postgres.
- [ ] WorkOS callback URL is configured.
- [ ] Autumn products/features are synced from `apps/cloud/autumn.config.ts`.
- [ ] GitHub `production` environment secrets are present.
- [ ] Worker runtime secrets are present.
- [ ] `cd apps/cloud && bun run db:migrate:ci` succeeds against production.
- [ ] Deploy workflow succeeds.
- [ ] `/healthz` returns 200.
- [ ] `/readyz` returns 200 with the readiness token.

## Rollback

For app-only regressions, redeploy the previous successful GitHub SHA from the Actions UI with `run_migrations=false`.

For schema regressions, do not blindly roll back code. First inspect the Drizzle migration that shipped and create an explicit forward-fix migration. Production migrations are treated as irreversible unless a tested down-migration exists.

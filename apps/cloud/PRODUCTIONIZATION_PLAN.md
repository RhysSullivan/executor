# Executor B2B SaaS productionization plan

## Current foundation

Executor already has a strong SaaS-shaped core in `apps/cloud`:

- Cloudflare Worker + TanStack Start app shell.
- Durable Object MCP session runtime (`MCP_SESSION`).
- Postgres-backed storage through Hyperdrive / direct database URL fallback.
- WorkOS AuthKit + Organizations auth model.
- Autumn billing/usage hooks.
- API surface for sources, secrets, policies, tools, org membership, and execution usage.
- Sentry, Axiom/OTEL, and PostHog integrations.
- Vitest + Miniflare tests covering tenant isolation, secrets isolation, MCP auth/session flow, organization limits, and backend APIs.

## Production target architecture

1. **Cloud edge**
   - `executor-cloud` Cloudflare Worker serves app/backend/MCP.
   - Custom domain: `executor.sh`.
   - Durable Object binding: `MCP_SESSION` for long-lived MCP sessions.
   - Service binding: `MARKETING` for marketing pages.
   - Hyperdrive binding: `HYPERDRIVE` for production Postgres pooling.

2. **Data layer**
   - Managed Postgres for tenant/org/source/secret/policy/execution state.
   - Drizzle migrations run from GitHub Actions using `PRODUCTION_DATABASE_URL`.
   - Runtime uses Hyperdrive by default; direct `DATABASE_URL` only for CI/local.

3. **Identity / tenancy**
   - WorkOS AuthKit handles login/logout/callback/session refresh.
   - WorkOS Organizations maps users to org tenants.
   - App-side authorization scopes all mutable resources to organization id.
   - Admin/member roles used for org management and billing actions.

4. **Billing / metering**
   - Autumn products/features define plan entitlements.
   - Execution usage is tracked per organization.
   - Limits/entitlements gate sources, members, and executions.

5. **Observability / operations**
   - `/healthz` for deployment smoke checks.
   - `/readyz` for dependency readiness: Postgres + required secrets.
   - Sentry tunnel for frontend/server errors.
   - OTEL/Axiom spans for MCP/worker operations.
   - PostHog first-party proxy for product analytics.

## Implementation phases

### Phase 1 — deployment foundation (implemented in this branch)

- Add CI-friendly `db:migrate:ci` and `deploy:ci` scripts.
- Add Cloudflare/GitHub production deployment workflow.
- Add `.env.example` and `DEPLOYMENT.md` with required resources/secrets.
- Add `/healthz` and `/readyz` middleware before app/API routing.
- Add runtime env typings for WorkOS/build/readiness secrets.
- Verify typecheck, tests, and production build locally.

### Phase 2 — production account provisioning

- Create/verify Cloudflare Worker, route, Hyperdrive id, Durable Object migration, and marketing service binding.
- Create managed Postgres and wire Hyperdrive to it.
- Configure WorkOS AuthKit callback/logout URLs and organization roles.
- Configure Autumn products/features from `apps/cloud/autumn.config.ts`.
- Configure Sentry, Axiom, and PostHog projects.
- Add GitHub `production` environment secrets and Cloudflare Worker secrets.

### Phase 3 — launch hardening

- Add automated post-deploy `/readyz` monitor with `READINESS_TOKEN`.
- Add alerting for Worker errors, DB connection failures, and elevated MCP failure rates.
- Add rate limits / abuse controls around MCP execution and public auth endpoints.
- Add paid-plan gates to any remaining unaudited resource creation paths.
- Add admin audit log for source/secret/policy changes.
- Add customer onboarding checklist: invite org, connect source, test MCP client, verify billing usage.

### Phase 4 — scale / enterprise readiness

- SSO/SAML enterprise setup via WorkOS organizations.
- SCIM / directory sync if needed.
- Per-org data export/deletion workflows.
- More granular RBAC beyond `admin` / `member`.
- Region-aware data placement if customers require data residency.
- Dedicated enterprise org limits, support tooling, and incident runbooks.

## Acceptance criteria for production deploy

- `bun run typecheck` passes in `apps/cloud`.
- `bun run test` passes in `apps/cloud`.
- `bun run build` passes in `apps/cloud`.
- GitHub Actions deployment workflow succeeds.
- `https://executor.sh/healthz` returns 200 after deploy.
- `https://executor.sh/readyz` returns 200 with readiness token after secrets and DB are wired.
- WorkOS login/callback/logout works on production domain.
- A test organization can create sources/secrets/policies and run MCP tools.
- Autumn usage events show up for a test organization.

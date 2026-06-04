# host-nice — implementation status

`@executor-js/host-nice` is a fork of `apps/host-selfhost` re-targeted to run on
**nice-chatbot's Postgres** and **Better Auth identity**, with **multi-org**
enabled — the self-hosted executor hub from
`nice-chatbot/plans/EXECUTOR_SELFHOST_FINAL_PLAN.md`.

## Verification (current)

- ✅ **Typecheck clean** — `bun run typecheck` reports no errors in `host-nice`.
- ✅ **Migration smoke test passes** against a live Postgres 16: the real
  executor table set (blob, connection, credential_binding, definition,
  oauth2_session, plugin_storage, secret, source, tool, tool_policy, settings)
  is created in a dedicated `executor` schema and is idempotent on re-boot.
  ```bash
  POSTGRES_URL=postgres://postgres@127.0.0.1:5433/executor_test \
    bun run apps/host-nice/scripts/migrate-smoke.ts
  ```
- ✅ **Server boots end-to-end on Postgres** (`bun run src/serve.ts`):
  - `GET /api/health` → `{"status":"ok"}` (postgres-js reachable)
  - `GET /api/setup-status` → `{"needsSetup":true}` then `false` after the first
    signup (multi-org first-run logic)
  - `POST /api/auth/sign-up/email` → 200, user + session minted (Better Auth
    write path on Postgres)
  - Better Auth tables (organization, member, invitation, apikey, user, session,
    account, oauthApplication/AccessToken/Consent — i.e. the org + apiKey + mcp
    plugins) land in the **same `executor` schema** as executor's own source /
    tool / tool_policy / connection / secret tables. Single database, isolated
    schema, no collision with nice-chatbot's `public`.

## Done (Phase 0 + multi-org auth seams)

- **`package.json`** — `@executor-js/host-nice`; libSQL deps → Postgres
  (`postgres`, `pg`). (No direct `kysely` — better-auth bundles its own; adding
  it split `@better-auth/core` and broke plugin-tuple type inference.)
- **`src/config.ts`** — Postgres (`POSTGRES_URL`/`DATABASE_URL` + `executor`
  schema), **multi-org**, optional **OIDC delegation** to nice-chatbot, shared
  `BETTER_AUTH_SECRET` + cookie domain.
- **`src/db/postgres-db.ts`** — postgres-js + fumadb `provider: "postgresql"`,
  idempotent schema bring-up into the `executor` schema. Same `DbProvider`
  tag/shape as host-selfhost's `SelfHostDb`.
- **`src/auth/better-auth.ts`** — Better Auth over a pg Pool pinned to the
  `executor` schema; **multi-org** (no single-org session pin); plugins
  `organization`+`admin`+`apiKey`+`bearer`+`mcp`+`genericOAuth` (SSO, inert
  until OIDC env is set); optional bootstrap admin + default org via Better
  Auth's own API (no libSQL-specific seed). `resolveActiveOrganizationId`
  resolves a request's org from session → first membership → bootstrap default.
- **`src/auth/identity.ts`**, **`src/mcp/auth.ts`**,
  **`src/account/better-auth-account-provider.ts`** — multi-org: resolve the
  active org per request instead of a single pinned org.
- **`src/system/handlers.ts`** — health via postgres-js `sql`; setup-status =
  "no users yet".
- **`src/app.ts`** — wired to the Postgres handle; single-org invite-admin route
  removed.
- Deleted single-org libSQL machinery: `auth/seed.ts`, `auth/invites.ts`,
  `db/self-host-db.ts`, `admin/`, `testing/`.

## SSO bridge (Phases 1–2) — implemented

- **Client (host-nice):** `genericOAuth` provider `nice-chatbot` (env-gated on
  `EXECUTOR_OIDC_*`); `mapProfileToUser` stashes the org claim; a
  `user.create.after` hook find-or-creates the Executor org by slug and adds the
  user with the mapped role (`super_admin|admin → owner|admin`, else `member`).
  No-ops for email/password. Typecheck clean; boot + signup verified unregressed.
- **Provider (nice-chatbot):** `oidcProvider` plugin + `getAdditionalUserInfoClaim`
  emitting `organization_id/name/slug/role`. nice-chatbot also adds the
  `/executor` proxy, an org-scoped MCP registration helper (Phase 3), and a
  source-registration helper (Phase 4) — all typecheck-clean.

## Pending (runtime / operational — not code gaps)

- Exercise the **browser OAuth handshake** end-to-end with both apps deployed +
  `EXECUTOR_OIDC_*` / `EXECUTOR_COOKIE_DOMAIN` configured.
- **Source migration (Phase 4):** run `registerExecutorSource` against a live
  host-nice to move connectors/MCP/ACD tools into Executor sources; bridge OAuth
  → connections/secrets; set write policies to approval.
- **Phase 5 cutover:** retire duplicate hand-written tools once a team is fully
  served by Executor.
- Re-enable a multi-org test suite (the single-org tests were removed).

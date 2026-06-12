---
name: emulate
description: Use the @executor-js/emulate service emulators (GitHub, Google, Stripe, Resend, WorkOS, …) to test integrations for real — full OpenAPI specs, working OAuth flows, mintable credentials, and a request ledger for assertions. Use when a test or demo needs a real-shaped upstream API, an OAuth/OIDC provider, a spec to feed addSpec, or proof that a request actually landed.
---

# Emulate: production-fidelity service emulators

`@executor-js/emulate` (our fork of Vercel Labs' emulate, developed in
`vendor/emulate` but ALWAYS consumed as the published npm package — never
import from `vendor/`) provides stateful, wire-level emulators for 16
services: `github vercel google okta microsoft spotify slack apple aws
resend stripe mongoatlas clerk x workos autumn`. These are not mocks: real
SDKs and real product code run against them unmodified — the cloud e2e
target points the actual WorkOS SDK (sealed sessions, JWKS, hosted AuthKit
login) and Autumn billing at emulators and exercises the product's real
auth code.

## Two ways to get one

**Local, programmatic** (what `e2e/setup/cloud.boot.ts` does):

```ts
import { createEmulator } from "@executor-js/emulate";
const github = await createEmulator({ service: "github", port: 4501 });
// github.url, await github.close() — plus the full typed client below
```

`baseUrl` sets the _advertised_ origin (redirects, form actions, spec
`servers`) when a proxy fronts the emulator — the bind stays on `port`.

**Attach to a running one** (another process, or hosted on Cloudflare with
Durable Object state at `https://<service>.emulators.dev` /
`https://<service>.<instance>.emulators.dev` — catalog at
`GET https://emulators.dev/_emulate/services`):

```ts
import { connectEmulator } from "@executor-js/emulate";
const resend = await connectEmulator({ baseUrl: "https://resend.emulators.dev" });
// optional: { service: "resend" } verifies the manifest on connect
```

Create a private hosted instance with `POST /_emulate/instances` on the
service host.

## The typed control-plane client

Both `createEmulator` and `connectEmulator` return the same `EmulatorClient`
surface (since 0.7.0) — use it instead of hand-rolling `/_emulate` fetches:

| Call                                                               | Use                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `client.openapiUrl`                                                | The spec URL — feed it straight to Executor's addSpec to register the emulator as an integration                               |
| `client.credentials.mint({type:"api-key"})`                        | `IssuedCredential` in the service's real shape: API keys, bearer tokens, OAuth/OIDC clients, client-credentials apps           |
| `client.ledger.list()` / `.clear()`                                | `LedgerEntry[]`: matched operationId, sanitized headers/body, auth identity, response status, webhook deliveries               |
| `client.seed({...})`                                               | Add state via the service's seed schema (e.g. WorkOS `{oauth:{default_access_token_ttl_seconds:60}}` to compress token expiry) |
| `client.reset()`                                                   | Reset state + logs, replay seed — works remotely, unlike the old local-only reset                                              |
| `client.manifest()` / `.quickstart()` / `.specs()` / `.coverage()` | What the service is, which operations are real vs partial                                                                      |
| `client.state()` / `.logs()` / `.connections()`                    | Store snapshot, webhook deliveries, copyable SDK/env/curl snippets                                                             |

The same routes exist as raw HTTP under `/_emulate/*` (start at
`GET /_emulate/quickstart`, written for agents) for curl/browser use — but in
TypeScript, reach for the client; the types are the point.

## Recipes

**Test an integration end-to-end for real** (the `connect-handoff` pattern):
`client.credentials.mint(...)` → register `client.openapiUrl` with the
product → invoke a tool through the product → find the call in
`client.ledger.list()` (match on `entry.request.body` / `operationId`). The
ledger is the proof — "the product made this exact upstream call with this
auth" — which beats asserting on the product's own response.

**Real OAuth/OIDC flows**: google/okta/microsoft/apple/clerk/workos mint
OAuth clients and run real authorize/token endpoints. The WorkOS emulator
additionally serves hosted AuthKit login pages (any email signs in — users
are minted on the fly, no password), an OAuth authorization server for MCP
clients, and Vault KV. Real SDK + `WORKOS_API_URL` override = the product's
untouched auth code against it. Set `EMULATE_WORKOS_AUDIENCE=<client_id>`
before `createEmulator` so minted MCP access tokens carry the right audience.

**A live, human-pokeable cloud instance with zero .env**:
`cd e2e && bun run cli up cloud --share` — WorkOS + Autumn emulators + the
app's real dev stack (recipe in `e2e/setup/cloud.boot.ts`), fronted with
tailscale HTTPS.

## Gotchas

- **Secure cookies need HTTPS off-localhost.** Browser-driven flows work on
  `127.0.0.1`, but from another device (tailnet) the app's `secure: true`
  auth cookies are dropped over http → "Invalid login state". Front BOTH the
  app and the emulator with HTTPS (`tailscale serve`), and give the emulator
  its public origin via `baseUrl` AND the app's `WORKOS_API_URL` — the
  authorize URL the browser follows is derived from the latter.
- **State is per-process and id counters restart.** The WorkOS emulator
  mints org ids from a per-boot counter — a persisted app DB from a previous
  boot collides with new ids. Wipe the app's data dir when you restart the
  emulator (the e2e globalsetup and cloud-demo both do).
- **Don't hand-write fake upstreams.** If a scenario needs an upstream API,
  OAuth provider, or webhook source, reach for an emulator before writing a
  bespoke stub server — you get specs, auth, and the ledger for free, and
  the e2e AGENTS.md "never modify product code or stubs" rule stays intact.

# Writing e2e scenarios

A scenario is ONE user-meaningful product journey, written once against the
`Target` interface and run on every deployment that supports its capabilities.
Tests are **black-box**: drive the product only through public surfaces (typed
API, web UI, MCP, CLI). Never import app internals, never poke the DB, never
modify product code or stubs — if the product or stub blocks you, STOP and
report the blocker instead of working around it.

## File placement

- `scenarios/*.test.ts` — runs on every target (cloud + selfhost)
- `cloud/*.test.ts` — cloud-only (e.g. billing, WorkOS-session UI)
- `selfhost/*.test.ts` — selfhost-only

## Anatomy

```ts
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { scenario } from "../src/scenario";

const coreApi = composePluginApi([] as const); // tools/integrations/connections/providers/executions/oauth/policies

scenario("Tools · a fresh workspace advertises the built-in tools", { needs: ["api"] }, (ctx) =>
  Effect.gen(function* () {
    ctx.rec.say("What the user is trying to do, in one sentence."); // narration turn
    const identity = yield* ctx.target.newIdentity(); // fresh isolated user+org
    const client = yield* ctx.api.client(coreApi, identity); // typed HttpApiClient
    const tools = yield* ctx.api.call("tools.list", {}, client.tools.list()); // recorded call
    ctx.rec.expect(tools.length, "why this matters").toBeGreaterThan(0); // recorded assertion
  }),
);
```

- `ctx.rec.say(...)` — explain intent BEFORE acting; this is what makes the
  recording reviewable. One say() per logical beat.
- `ctx.api.call(name, args, effect)` — ALWAYS wrap typed-client calls so they
  land in the transcript.
- `ctx.rec.expect(actual, label).toBe/toContain/toMatch/toBeGreaterThan(...)`
  — recorded assertions with a human label. Use these, not vitest `expect`.
- Capabilities (`needs`): `api`, `browser` (cloud only today), `mcp-oauth`
  (selfhost only today), `billing` (cloud only).

## Browser scenarios (cloud)

```ts
const identity = yield * ctx.target.newIdentity(); // logged in, has an org
// or newIdentity({ org: false }) for the onboarding flow
yield *
  ctx.browser.session(identity, async ({ page, step }) => {
    await step("A fresh user lands on the integrations page", async () => {
      await page.goto("/", { waitUntil: "networkidle" });
      await page.getByText("Integrations").first().waitFor();
    });
  });
```

- Every `step(label, fn)` = screenshot + video slice in the recording. Label
  steps as user actions ("Open the org switcher"), not selectors.
- Prefer role-based locators (`getByRole("menuitem", ...)`) — text locators
  often match the look-alike trigger button in the bottom bar.
- After an action that navigates, wait for the URL/network to settle before
  opening menus: `await page.waitForLoadState("networkidle")`.
- The stub user renders as "Test User" / `test@example.com`.

## MCP scenarios (selfhost)

```ts
const session = ctx.mcp.session(identity);
const tools = yield * session.listTools(); // OAuth happens headlessly here
const r = yield * session.call("execute", { code: "return 1 + 1;" });
// human-in-the-loop: session.approvePaused(r.text) resumes a paused execution
```

## Running

Servers are ALREADY RUNNING — attach, don't boot:

```sh
cd e2e
E2E_CLOUD_URL=http://127.0.0.1:4798 ../node_modules/.bin/vitest run --project cloud <file>
E2E_SELFHOST_URL=http://localhost:4799 ../node_modules/.bin/vitest run --project selfhost <file>
```

A run writes `runs/<target>/<slug>/run.json` + screenshots/video. Iterate until
green. On failure, read the run.json error and the `*-failure.png` screenshot —
it shows the screen at the moment of failure.

## Discovering endpoints

- The full OpenAPI spec: `curl http://127.0.0.1:4798/api/openapi.json` (cloud).
- The typed client mirrors it: `client.<group>.<endpoint>(...)` with groups
  tools/integrations/connections/providers/executions/oauth/policies.
- To see payload shapes, read the API definitions under
  `packages/core/api/src/<group>/api.ts` (READ ONLY — for shapes, not imports).

## Isolation rules

- Cloud: `newIdentity()` is a fresh user+org — you are isolated for free.
- Selfhost: everyone is the bootstrap admin. PREFIX every resource you create
  with your scenario slug (e.g. secret name `secrets-roundtrip-token`) so
  parallel scenarios don't collide, and don't assert on global counts
  (assert "contains mine", not "length is 1").

## Quality bar

- The scenario name reads like a product guarantee ("Billing · the free plan
  stops organization creation after 3"), not a test id.
- A reviewer must be able to open the run in the viewer and judge correctness
  WITHOUT reading the source: intent (say) → action (step/call) → evidence →
  assertion, in that order.
- Assert outcomes the user cares about, not implementation details. No
  tautologies (don't assert what the setup already guarantees).
- Keep it deterministic: no sleeps; wait on conditions.

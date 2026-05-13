# Real Protocol Testing and Fetch Boundaries

Executor's plugin tests should make realistic scenarios easy to write. For
OpenAPI, MCP, and GraphQL, that means tests should usually talk to real local
protocol servers instead of hand-written stubs, patched globals, or canned
responses. The boundary should still be deterministic and cheap: local port 0
servers, in-memory stores, Effect layers, and explicit test services.

This note covers the testing framework shape and the raw `fetch` lint boundary
needed to make protocol tests mockable through Effect.

## Goals

- Make realistic protocol scenarios easy to test for OpenAPI, MCP, and GraphQL.
- Reuse those same real protocol fixtures in CLI, local app, and cloud app e2e
  tests so app-level suites prove the full invoke flow still works.
- Keep protocol-specific test services inside the plugin packages that own the
  protocol.
- Keep shared SDK testing support limited to protocol-agnostic fixtures.
- Prefer Effect `Layer`/`TestLayer` composition over ad hoc setup functions.
- Remove test patterns that patch `globalThis.fetch`.
- Ban raw `fetch` in application and plugin code, except for narrow approved
  boundary adapters and platform entrypoints.
- Keep parser/extractor unit tests cheap and pure where a real server adds no
  value.

## Non-goals

- Do not build a large central test framework in core.
- Do not move plugin-specific protocol servers into `@executor-js/sdk`.
- Do not force every pure parsing test through HTTP.
- Do not expose test helpers through runtime `./api` exports.
- Do not add browser or worker harnesses for plugin SDK tests unless the
  behavior actually depends on those runtimes.

## Decisions

Testing services belong behind explicit `./testing` subpath exports:

```txt
@executor-js/sdk/testing
@executor-js/plugin-openapi/testing
@executor-js/plugin-mcp/testing
@executor-js/plugin-graphql/testing
```

The plugin packages own the protocol details. Core SDK testing owns only boring
Executor fixtures such as memory adapters, memory secrets, auto-accept
elicitation, and other Effect-native test primitives.

Use `TestLayer` / `TestLayers` naming for realistic local test services.
Reserve `LiveLayer` / `LiveLayers` for production wiring. These servers are
real protocol servers, but they are still test services because their upstream
state and behavior are controlled by tests.

Use `Layer.provideMerge` when a test needs access to both the live behavior and
the test service state, such as captured requests, session counts, issued
tokens, or mutable scenario refs. Use `Layer.fresh` where shared layer
memoization would leak state across tests.

The same fixtures should be usable above the plugin SDK layer. A real OpenAPI,
MCP, or GraphQL fixture should be able to sit beside an `apps/cli`,
`apps/local`, or `apps/cloud` e2e harness and prove that the complete source
add, discovery, execute, approval, auth, and invoke path works through the
product entrypoint, not only through direct plugin calls.

## Current State

`packages/core/sdk/src/testing.ts` already provides the base Executor test
configuration through `makeTestConfig`. It creates the memory adapter, memory
blob store, test scopes, and auto-accept elicitation defaults. This is the
right home for cross-plugin Executor fixtures, but it is not enough for
protocol-specific scenarios.

OpenAPI already has the strongest real-server pattern. In
`packages/plugins/openapi/src/sdk/plugin.test.ts`, tests define an Effect
`HttpApi`, serve it with `HttpRouter.serve`, provide
`NodeHttpServer.layerTest`, and pass the resulting `HttpClient` layer into the
plugin. This is the model to preserve and formalize. The weak spots are
duplicated helpers and OAuth tests such as
`packages/plugins/openapi/src/sdk/oauth-refresh.test.ts` that patch
`globalThis.fetch`.

MCP already has a useful real HTTP helper in
`packages/plugins/mcp/src/sdk/test-utils.ts`. It starts a real node HTTP server,
creates `McpServer` instances, and routes `StreamableHTTPServerTransport`
sessions with `mcp-session-id`. That should become a plugin-owned testing
export rather than staying as private test utility code. The MCP shape probe in
`packages/plugins/mcp/src/sdk/probe-shape.ts` still accepts a fetch injection
and defaults to `globalThis.fetch`.

GraphQL is the largest realism gap. `packages/plugins/graphql/src/sdk/plugin.test.ts`
mostly uses hand-written `introspectionJson`; one invocation path has a tiny
HTTP server but still uses canned introspection. The plugin should have a real
GraphQL test server that supports introspection and operation execution through
the same HTTP endpoint used by the plugin.

Raw fetch usage is wider than these plugins. It appears in OAuth discovery,
OAuth helper tests, MCP probe tests, Google Discovery, cloud/local app tests,
release smoke tests, and some app runtime code. The lint rule should be added
with a clear boundary model and a temporary migration allowlist, not as a
blind repo-wide flip.

## Target Package Shape

Add source and publish exports for `./testing` in the SDK and each protocol
plugin package.

```jsonc
{
  "exports": {
    ".": "./src/sdk/index.ts",
    "./testing": "./src/testing/index.ts",
  },
}
```

For `@executor-js/sdk`, either keep `src/testing.ts` as the subpath entrypoint
or move it to `src/testing/index.ts` with a compatibility export from the root
SDK. Avoid breaking existing imports of `makeTestConfig`.

Suggested file layout:

```txt
packages/core/sdk/src/testing.ts
packages/core/sdk/src/testing/
  memory-secrets.ts

packages/plugins/openapi/src/testing/
  index.ts
  server.ts
  oauth-server.ts

packages/plugins/mcp/src/testing/
  index.ts
  server.ts

packages/plugins/graphql/src/testing/
  index.ts
  server.ts
```

The public testing surface should export services and layers, not large
scenario-specific suites.

```ts
export class OpenApiTestServer extends Context.Service<OpenApiTestServer>()("OpenApiTestServer", {
  effect: Effect.gen(function* () {
    return {
      baseUrl,
      specJson,
      requests,
    } as const;
  }),
}) {
  static readonly layer = (options: OpenApiTestServerOptions) =>
    Layer.effect(this, makeOpenApiTestServer(options));
}

export const TestLayers = {
  openApiServer: OpenApiTestServer.layer,
  oauthServer: OAuthTestServer.layer,
};
```

The exact class/factory shape can follow local Effect style, but tests should
compose layers directly:

```ts
layer(OpenApiTestLayers.itemsApi.pipe(Layer.provideMerge(SdkTestLayers.executor())))(
  "OpenAPI plugin",
  (it) => {
    it.effect("invokes a real endpoint", () =>
      Effect.gen(function* () {
        const server = yield* OpenApiTestServer;
        // add source with server.specJson and invoke through the plugin
      }),
    );
  },
);
```

## Shared SDK Testing

Keep SDK testing small and protocol-neutral.

Useful additions:

- `memorySecretsPlugin()` or `MemorySecretsTestLayer`, replacing repeated
  in-test secret provider definitions.
- `makeExecutorTestLayer(options)`, if repeated `createExecutor(makeTestConfig)`
  setup becomes noisy.
- Small request/response capture primitives built on `Ref`, only if multiple
  plugins need the same shape.

Avoid generic "scripted server" abstractions unless at least two plugins need
the same non-trivial behavior. A protocol-specific server in the owning plugin
is easier to understand and less likely to leak protocol details into core.

## OpenAPI Test Layers

OpenAPI should first formalize the pattern that already works.

Work:

- Extract reusable server helpers from `plugin.test.ts` and related tests into
  `packages/plugins/openapi/src/testing`.
- Keep Effect `HttpApi` as the main way to define test OpenAPI servers.
- Provide a helper that returns the bound base URL and spec JSON with
  `servers: [{ url: baseUrl }]` already patched in.
- Add request capture for headers, query params, body bytes, and method/path.
- Add an OAuth authorization/token test server for client credentials,
  authorization code, refresh success, refresh failure, and token rotation
  scenarios.
- Migrate OAuth tests away from `globalThis.fetch` patching.

Representative scenarios:

- preview a generated spec from a real `HttpApi`
- add source from URL and from inline spec
- invoke GET and POST operations against the real server
- approval behavior for non-GET operations
- header/query secret resolution
- bearer token selection across scopes
- OAuth refresh and retry behavior
- non-JSON and validation-error response handling

## MCP Test Layers

MCP should promote the existing streamable HTTP helper into a public testing
surface and make the scenario state accessible through Effect.

Work:

- Move or wrap `packages/plugins/mcp/src/sdk/test-utils.ts` under
  `packages/plugins/mcp/src/testing`.
- Export a `McpTestServer` service with `url`, `sessionCount`, captured
  requests, and lifecycle handled by `Effect.acquireRelease`.
- Support a fresh `McpServer` factory per session, matching the current helper.
- Keep malformed/non-MCP HTTP endpoints as explicit test layers for probe
  behavior.
- Replace fetch-injected probe tests with real local HTTP servers and
  Effect-native HTTP boundaries.

Representative scenarios:

- discover tools from a real streamable HTTP MCP server
- invoke a real MCP tool
- multiple sessions remain isolated
- stale or unknown `mcp-session-id` returns protocol-accurate failure
- probe distinguishes real MCP from HTML, GraphQL errors, 400s, 404s, and
  OAuth metadata redirects
- connection auth headers and secret-backed query params are sent correctly

## GraphQL Test Layers

GraphQL should gain a real executable schema server. This is the place where a
new dependency may be justified.

Use `graphql-yoga` for the test server. The extra dependency is justified
because the fixture needs to exercise a real JSON-over-HTTP GraphQL endpoint,
not only direct `graphql(...)` execution. Keep Vitest configured to inline the
Yoga/GraphQL dependency chain so executable schemas and server execution share
one GraphQL module realm.

Work:

- Add `packages/plugins/graphql/src/testing` with a `GraphqlTestServer` layer.
- Support executable schemas with query and mutation resolvers.
- Return real introspection results from the server instead of canned JSON.
- Capture requests and headers so auth behavior is assertable.
- Provide helpers for common schema fixtures, but keep custom schema creation
  easy.
- Migrate plugin behavior tests from `introspectionJson` to a live endpoint.
- Keep pure extraction tests on static introspection JSON where that is the
  unit under test.

Representative scenarios:

- add source by introspecting a real endpoint
- register query and mutation tools from the real schema
- invoke query with variables
- invoke mutation and require approval
- propagate GraphQL `errors` envelopes
- attach static headers and secret-backed bearer tokens
- update source endpoint/headers without re-registering tools
- handle schema changes on refresh or re-add

## Fetch Boundary

The target rule is: product and plugin code should not call raw `fetch`
directly. HTTP should go through Effect HTTP. If a third-party library truly
forces a fetch-shaped callback, the adapter should live at that owning package's
boundary rather than in shared SDK testing.

Boundary files may exist, but they should be explicit and scarce. Examples:

- a core OAuth adapter for `oauth4webapi` custom fetch, if that library forces it
- a MCP transport adapter if the upstream MCP SDK requires fetch-shaped input
- platform entrypoints that must implement a `fetch(request, env, ctx)` method
- test harnesses that intentionally call a Worker binding's `fetch` method

Everything else should use Effect HTTP, Executor client APIs, or an explicit
package-local boundary.

Lint plan:

- Add `executor/no-raw-fetch` under `scripts/oxlint-plugin-executor/rules`.
- Register it in `scripts/oxlint-plugin-executor.js` and `.oxlintrc.jsonc`.
- Detect direct calls to global `fetch(...)` and `globalThis.fetch(...)`.
- Detect assignments or defaulting to `globalThis.fetch`, because that usually
  preserves the same ambient dependency under another name.
- Do not flag object methods named `fetch` by default, so Worker handlers and
  bindings can be managed through explicit allowlist rules rather than noisy
  false positives.
- Start with a narrow allowlist for known boundary files and remove entries as
  migrations land.
- Include error messages that tell the author which Effect HTTP or approved
  package-local boundary to use.

The lint rule can land once the core test primitives and at least one real
protocol fixture exist. Fetch-shaped adapters should be added only at forced
library boundaries during migration.

## Migration Order

1. Add `./testing` exports and SDK test primitives.
   - Expose `@executor-js/sdk/testing`.
   - Add memory secrets test support.
   - Keep `makeTestConfig` available from the root SDK.

2. Build the GraphQL vertical slice.
   - Add the real GraphQL test server layer.
   - Migrate a representative set of GraphQL plugin tests off canned
     `introspectionJson`.
   - Keep pure extractor tests separate.

3. Promote OpenAPI and MCP existing helpers.
   - Move OpenAPI real `HttpApi` helpers into `./testing`.
   - Move MCP streamable HTTP helper into `./testing`.
   - Migrate current tests to import from the new public testing subpaths.

4. Replace global fetch patching.
   - Convert core OAuth discovery/helper tests to real local servers or
     package-local Effect HTTP boundaries.
   - Convert OpenAPI OAuth tests to the OAuth test server.
   - Convert MCP probe tests to real local HTTP server layers.
   - Convert Google Discovery tests using the same boundary pattern.

5. Add and enforce the raw fetch lint rule.
   - First enforce it for plugin SDK packages and core SDK.
   - Then tighten app code once cloud/local worker-specific boundaries are
     classified.
   - Remove temporary allowlist entries as each package is migrated.

6. Broaden scenario coverage.
   - Add failure-mode suites for auth, malformed protocol responses, refresh
     flows, schema changes, and multi-scope source shadowing.
   - Prefer one real server layer plus scenario state over many one-off stubs.

7. Reuse fixtures in app-level e2e tests.
   - Add CLI e2e coverage that starts a real protocol fixture, adds the source
     through the CLI-supported path, invokes a tool, and asserts the fixture saw
     the expected request.
   - Add local app coverage that drives the local API/server path through the
     same source add and invoke flow.
   - Add cloud app coverage that runs the worker/miniflare harness against real
     protocol fixtures where the runtime supports it.
   - Keep app e2e assertions focused on integration boundaries: transport,
     source persistence, auth/secret resolution, tool discovery, elicitation,
     and invocation.

## Verification

Use Vitest for test execution, not `bun test`.

Targeted commands during migration:

```sh
vitest run packages/plugins/graphql/src/**/*.test.ts
vitest run packages/plugins/openapi/src/**/*.test.ts
vitest run packages/plugins/mcp/src/**/*.test.ts
vitest run packages/core/sdk/src/**/*oauth*.test.ts
vitest run apps/local/src/**/*.test.ts
vitest run apps/cloud/src/**/*.test.ts
```

Repo-level checks before merging:

```sh
bun run lint
bun run typecheck
bun run test
```

The root `bun run test` delegates to package `vitest run` scripts through
Turbo. Do not use `bun test`.

## Open Questions

- Should `@executor-js/sdk/testing` be a new subpath around the existing
  `src/testing.ts`, or should `src/testing.ts` become `src/testing/index.ts`?
- How much GraphQL HTTP behavior should live in the shared fixture versus
  scenario-specific schemas in individual tests?
- Which app-level raw fetch calls should remain approved platform boundaries
  versus being migrated to Effect HTTP?
- Should the raw fetch lint rule become repo-wide immediately with allowlists,
  or package-scoped first for core SDK and protocol plugins?
- How much of the existing cloud MCP real-port harness should be promoted
  versus left as an app-specific integration harness?

## References

Current Executor code:

- `packages/core/sdk/src/testing.ts`
- `packages/plugins/openapi/src/sdk/plugin.test.ts`
- `packages/plugins/openapi/src/sdk/oauth-refresh.test.ts`
- `packages/plugins/mcp/src/sdk/test-utils.ts`
- `packages/plugins/mcp/src/sdk/probe-shape.ts`
- `packages/plugins/graphql/src/sdk/plugin.test.ts`
- `scripts/oxlint-plugin-executor.js`
- `.oxlintrc.jsonc`
- `notes/old/mcp-testing.md`

Effect reference patterns:

- `https://github.com/Effect-TS/effect-smol`
- local reference commit:
  `.reference/effect-smol` at `f862e40573b6d1c04942799be5ff6f7dbea22ae9`
- `ai-docs/src/09_testing/20_layer-tests.ts` for `layerTest` and
  `Layer.provideMerge` test state exposure
- `packages/platform-node/src/NodeHttpServer.ts` for `NodeHttpServer.layerTest`
  and test client wiring

t3code reference patterns:

- `https://github.com/pingdotgg/t3code`
- local reference commit:
  `.reference/t3code` at `22384ae977a362c547d6f57d4e3d92bbe55ee5db`
- `apps/server/src/config.ts` for service-local `layerTest`
- `apps/server/src/serverSettings.ts` for in-memory test service layers
- `apps/server/integration/OrchestrationEngineHarness.integration.ts` for
  realistic integration layer composition with explicit fakes at the edges
- `apps/server/src/checkpointing/Layers/CheckpointStore.test.ts` for real
  filesystem/git style tests composed through layers
- `apps/server/src/provider/testUtils/providerAdapterRegistryMock.ts` for
  scenario-specific harnesses that stay near the owning domain

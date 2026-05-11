---
"@executor-js/sdk": minor
"@executor-js/plugin-mcp": minor
"@executor-js/plugin-graphql": minor
"@executor-js/plugin-openapi": minor
"@executor-js/plugin-onepassword": minor
"@executor-js/plugin-google-discovery": minor
"@executor-js/codemode-core": patch
"@executor-js/plugin-example": patch
---

Stop the published plugin bundles from importing `@executor-js/api`. The
private server package was being pulled into every SDK chunk via
`import { InternalError } from "@executor-js/api"` (in each plugin's
group definition) and `import { addGroup, capture } from
"@executor-js/api"` (via the SDK's transitive import of its own
handlers). Because `@executor-js/api` is `private: true`, plain Node
ESM consumers hit `Cannot find package '@executor-js/api'` on
`import("@executor-js/plugin-mcp/core")` (and the same for graphql /
openapi).

Fix:

- `InternalError` (the wire-level 500 schema) moved to
  `@executor-js/sdk/core`. `@executor-js/api` re-exports it for
  back-compat, so server code is unaffected.
- The plugin SDK factories (`mcpPlugin`, `graphqlPlugin`,
  `openApiPlugin`, `onepasswordPlugin`, `googleDiscoveryPlugin`) no
  longer carry HTTP `routes` / `handlers` / `extensionService`. The
  optional fields are layered on by a new HTTP-augmented variant
  exposed from the `/api` subpath (`mcpHttpPlugin`,
  `graphqlHttpPlugin`, `openApiHttpPlugin`, `onepasswordHttpPlugin`,
  `googleDiscoveryHttpPlugin`).
- Hosts that mount plugin HTTP routes should switch their imports to
  the `/api` subpath and the `*HttpPlugin` factory name.
- SDK-only consumers keep importing from the package root and no
  longer transitively require `@executor-js/api`.

Breaking for hosts that read `mcpPlugin(opts).routes` /
`.handlers` / `.extensionService` directly off the SDK factory's
return value — switch to the `*HttpPlugin` factory from
`@executor-js/plugin-*/api`.

Two unrelated published-bundle bugs surfaced by the new release-time
smoke test (see `scripts/smoke-test-packed.ts`) are also fixed:

- `@executor-js/codemode-core` was importing `ajv/dist/2020` without a
  `.js` extension. Strict ESM resolvers reject extension-less subpath
  imports, so the published bundle failed at load with `Cannot find
  module '.../ajv/dist/2020'`.
- `@executor-js/plugin-example`'s `./shared` and `./server` entries
  imported `HttpApiEndpoint` / `HttpApiGroup` / `HttpApi` /
  `HttpApiBuilder` from `@executor-js/sdk` (the slim Promise entry,
  which doesn't re-export them). Switched to `@executor-js/sdk/core`,
  the full SDK surface where those re-exports live.

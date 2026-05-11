---
"@executor-js/sdk": minor
"@executor-js/plugin-mcp": minor
"@executor-js/plugin-graphql": minor
"@executor-js/plugin-openapi": minor
"@executor-js/plugin-onepassword": minor
"@executor-js/plugin-google-discovery": minor
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

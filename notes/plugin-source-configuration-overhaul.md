# Plugin Source Configuration Overhaul

Date: 2026-05-18
Status: implemented in progress

## Goal

Turn the source credential/configuration work into a full plugin overhaul instead
of an incremental OpenAPI cleanup.

Implementation goal for this PR:

```txt
PR #844 should become the complete source-configuration overhaul for first-party
source plugins. OpenAPI, GraphQL, and MCP should all move onto plugin-derived
configure APIs, shared core credential bindings, shared HTTP credential helpers
where applicable, JSON-backed plugin source config, and composed shared React
credential UI. The old plugin-specific binding wrappers, endpoints, stores,
credential child tables, and duplicated UI atoms should be removed rather than
kept as compatibility shims.
```

By the end, OpenAPI, GraphQL, and MCP should share the same underlying source
configuration architecture:

- Core owns generic source identity, scoped credential bindings, source
  configure dispatch, and validation.
- Plugins own their source-specific configure schemas and source config
  decoding.
- HTTP-ish plugins share HTTP credential config, runtime helpers, and React
  components through a shared HTTP package.
- Plugin-private storage remains an overridable plugin facility, backed by one
  shared plugin storage table rather than plugin-specific SQL tables.
- Duplicated OpenAPI/GraphQL/MCP binding endpoints, stores, React atoms, and
  child tables should be deleted aggressively.

The desired result is that a future improvement to HTTP credential handling
such as adding a plaintext header path, changing the secret input UI, or
improving OAuth flows benefits OpenAPI, GraphQL, and MCP HTTP rather than being
reimplemented per plugin.

## Settled Decisions

- This can be one large PR/overhaul, not a series of small incremental PRs.
- `executor.sources.configure(...)` should be implemented in this overhaul.
- Plugin-native configure APIs should remain:
  - `executor.openapi.configure(...)`
  - `executor.graphql.configure(...)`
  - `executor.mcp.configure(...)`
- Low-level binding APIs should be hidden from normal consumers where possible.
  They may remain exported for internal/advanced use, but product and SDK
  happy paths should lead with configure.
- Source config may move to JSON. Use Effect Schema at boundaries.
- Migrations are one-shot migrations. Preserve existing source configuration and
  credential values.
- Persist source config; derive slot manifests from source config.
- Add a shared HTTP package, likely `@executor-js/plugin-http-source`.
- MCP configure should be transport-discriminated.
- Shared UI components can omit MCP stdio for this pass.
- Plaintext credential values are not needed unless a current flow already has
  them.
- OAuth should be designed for the long-term model, not as a short-term header
  hack.
- UI should be hand-composed from reusable components, not generated entirely
  from manifests.
- GraphQL can use the same request URL/credential config for introspection for
  now.
- MCP may require auth at add time if auth is needed to list tools.
- Naming like `request`, `specFetch`, `introspection`, `transport`, `env`, and
  `query` is acceptable.

## Storage Model

Do not kill plugin storage.

The overhaul should separate three storage concerns that are currently blurred:

1. First-class Executor source records.
2. Scoped credential values.
3. Plugin-private state/cache/documents.

### First-Class Source Records

Sources are product entities. Core needs to list them, scope them, remove them,
refresh them, attach tools/policies to them, and expose them through generic
source APIs.

Source records should remain first-class, but plugin-specific source details can
move into plugin-owned JSON config decoded by Effect Schema.

For example:

```txt
openapi_source
  id
  scope_id
  name
  config_json
```

```txt
graphql_source
  id
  scope_id
  name
  config_json
```

```txt
mcp_source
  id
  scope_id
  name
  config_json
```

The exact physical table shape can follow the repo's current storage layout, but
the duplicated credential child tables should go away where they only represent
source config and binding placeholders.

Plugin packages own their config schemas:

```ts
export const OpenApiStoredSourceConfig = Schema.Struct({
  request: Schema.optional(HttpRequestSourceConfig),
  specFetch: Schema.optional(HttpRequestSourceConfig),
  // OpenAPI-specific spec/base URL/operation details...
});
```

```ts
export const GraphqlStoredSourceConfig = Schema.Struct({
  request: Schema.optional(HttpRequestSourceConfig),
  // GraphQL-specific endpoint/schema details...
});
```

```ts
export const McpStoredSourceConfig = Schema.Union(
  Schema.Struct({
    transport: Schema.Literal("http"),
    request: Schema.optional(HttpRequestSourceConfig),
    // MCP HTTP details...
  }),
  Schema.Struct({
    transport: Schema.Literal("stdio"),
    command: Schema.String,
    args: Schema.Array(Schema.String),
    env: Schema.Record({ key: Schema.String, value: ProcessEnvSourceConfig }),
  }),
);
```

### Credential Bindings

Core `credential_binding` remains the only place scoped credential values live.

```txt
credential_binding
  plugin_id
  source_id
  source_scope_id
  scope_id
  slot_key
  kind
  secret_id
  secret_scope_id
  connection_id
  text_value
  created_at
  updated_at
```

Source config declares slots and their wire-format meaning. Credential bindings
store scoped values for those slots.

Example OpenAPI source config:

```ts
{
  request: {
    headers: {
      Authorization: {
        slotKey: "request.headers.authorization",
        prefix: "Bearer ",
      },
    },
    query: {},
  },
  specFetch: {
    headers: {},
    query: {},
  },
}
```

Example value:

```txt
credential_binding
  plugin_id = "openapi"
  source_id = "stripe"
  source_scope_id = "org_acme"
  scope_id = "user_rhys"
  slot_key = "request.headers.authorization"
  kind = "secret"
  secret_id = "stripe_api_key"
```

### Plugin-Private Storage

Plugin storage should remain as an overridable facility.

The target is one shared table for all plugin-private storage, partitioned by
plugin and collection:

```txt
plugin_storage
  plugin_id
  collection
  scope_id
  key
  data_json
  created_at
  updated_at
```

Primary key:

```txt
(plugin_id, collection, scope_id, key)
```

This is for plugin-owned private state/cache/documents:

- OAuth state caches.
- Remote metadata caches.
- Probe results.
- Background job state.
- Plugin-specific documents that are not first-class Executor sources.

The plugin storage API should remain overridable when constructing the executor
or installing/creating a plugin. This is separate from source storage and
credential binding storage.

Conceptually:

```ts
createExecutor({
  pluginStorage: myPluginStorageProvider,
});
```

or, if plugin-level override is already the local pattern:

```ts
openApiPlugin({
  storage: myPluginStorageProvider,
});
```

The exact wiring should preserve the repo's existing ability for users to
override plugin storage. The overhaul should consolidate plugin-private storage
tables, not remove plugin storage.

### What We Are Deleting

Delete plugin-specific storage that only duplicates source config or
credential-binding behavior.

Likely delete/replace:

- OpenAPI source binding wrappers and backing adapters.
- OpenAPI header/query/spec-fetch child tables that only store slot config.
- GraphQL header/query child tables.
- MCP header/query child tables.
- Plugin-specific binding resolvers/listers/validators.
- Plugin-specific HTTP binding endpoints.
- Plugin-specific React binding atoms.

Do not delete:

- First-class source records.
- Core `credential_binding`.
- Generic plugin-private storage.
- The ability to provide/override plugin storage.

## Configure API Model

Core gets a plugin-derived configure dispatch:

```ts
await executor.sources.configure(source, {
  type: "openapi",
  scope: user,
  request: {
    headers: {
      Authorization: SecretId.make("stripe_api_key"),
    },
  },
});
```

Plugin-native APIs remain:

```ts
await executor.openapi.configure(source, {
  scope: user,
  request: {
    headers: {
      Authorization: SecretId.make("stripe_api_key"),
    },
  },
});
```

```ts
await executor.graphql.configure(source, {
  scope: user,
  request: {
    headers: {
      Authorization: SecretId.make("github_token"),
    },
  },
});
```

```ts
await executor.mcp.configure(source, {
  scope: user,
  transport: "http",
  request: {
    headers: {
      Authorization: SecretId.make("mcp_token"),
    },
  },
});
```

MCP stdio is transport-specific and should not be forced through HTTP helpers:

```ts
await executor.mcp.configure(source, {
  scope: user,
  transport: "stdio",
  env: {
    GITHUB_TOKEN: SecretId.make("github_token"),
  },
});
```

Core dispatch:

```ts
const configure = (source, input) =>
  Effect.gen(function* () {
    const storedSource = yield* Sources.get(source);
    const implementation = yield* SourceConfigureRegistry.get(input.type);

    if (storedSource.type !== input.type) {
      return yield* new SourceTypeMismatch({
        source,
        expected: storedSource.type,
        received: input.type,
      });
    }

    const parsed = yield* Schema.decodeUnknown(implementation.schema)(input);

    return yield* implementation.configure(source, parsed);
  });
```

Plugin registration:

```ts
openapiPlugin.registerSourceConfigure({
  type: "openapi",
  schema: OpenApiConfigureInput,
  configure: openApiConfigure,
  manifest: deriveOpenApiCredentialManifest,
});
```

The plugin configure implementation compiles plugin input into core binding
operations:

```ts
const openApiConfigure = (source, input) =>
  Effect.gen(function* () {
    const bindings = yield* compileOpenApiConfigureBindings(source, input);

    yield* Sources.replaceBindings({
      source,
      scope: input.scope,
      slotPrefixes: ["request.", "specFetch."],
      bindings,
    });
  });
```

## Shared HTTP Package

Create a shared package for HTTP source helpers, likely:

```txt
packages/plugins/http-source
```

Package name:

```txt
@executor-js/plugin-http-source
```

This package is not core. It exists because OpenAPI, GraphQL, and MCP HTTP share
HTTP credential concepts while databases, CLIs, and MCP stdio do not.

It should own:

- HTTP credential config types.
- Header/query slot key helpers.
- OAuth config types.
- Binding compiler helpers.
- Runtime resolution helpers.
- Helpers that apply resolved credentials to HTTP requests.
- Slot manifest helpers.
- React credential components, either directly or via a `/react` subpath export.

Possible layout:

```txt
packages/plugins/http-source
  src/
    sdk/
      types.ts
      slots.ts
      configure.ts
      resolve.ts
      oauth.ts
    react/
      HttpCredentialsProvider.tsx
      HttpHeaderCredentials.tsx
      HttpQueryCredentials.tsx
      OAuthCredentials.tsx
    index.ts
```

Example shared config:

```ts
type HttpRequestSourceConfig = {
  headers?: Record<string, HttpCredentialSlotConfig>;
  query?: Record<string, HttpCredentialSlotConfig>;
  oauth?: HttpOAuthSourceConfig;
};
```

Example configure input:

```ts
type HttpRequestConfigureInput = {
  headers?: Record<string, CredentialInput>;
  query?: Record<string, CredentialInput>;
  oauth?: HttpOAuthConfigureInput;
};
```

OpenAPI can embed the shared shape twice:

```ts
type OpenApiConfigureInput = {
  type: "openapi";
  scope: ScopeId;
  request?: HttpRequestConfigureInput;
  specFetch?: HttpRequestConfigureInput;
};
```

GraphQL can embed it once for now:

```ts
type GraphqlConfigureInput = {
  type: "graphql";
  scope: ScopeId;
  request?: HttpRequestConfigureInput;
};
```

MCP HTTP can embed it behind a transport discriminant:

```ts
type McpConfigureInput =
  | {
      type: "mcp";
      transport: "http";
      scope: ScopeId;
      request?: HttpRequestConfigureInput;
    }
  | {
      type: "mcp";
      transport: "stdio";
      scope: ScopeId;
      env?: Record<string, CredentialInput>;
    };
```

## OAuth Direction

OAuth belongs with HTTP helpers, but it should not be modeled as only a header
value. OAuth configuration needs to support long-term flow requirements:

- Authorization URL.
- Token URL.
- Client ID.
- Client secret.
- Scopes.
- PKCE/auth-code state.
- Refresh behavior.
- Resulting token placement.

## Implementation Notes

This branch implements the core shape described above:

- `executor.sources.configure(...)` dispatches through the owning plugin's
  registered `sourceConfigure` implementation.
- `executor.openapi.configure(...)`, `executor.graphql.configure(...)`, and
  `executor.mcp.configure(...)` remain plugin-native entry points.
- OpenAPI, GraphQL, and MCP source/operation/plugin rows now use the shared
  `plugin_storage` table instead of plugin-specific SQL source/operation tables.
- Core `credential_binding` remains the shared source credential value store.
- GraphQL and MCP no longer expose plugin-specific source binding HTTP
  endpoints or SDK wrapper methods; React callers use core source credential
  binding atoms.
- Local and cloud one-shot migrations copy old plugin source rows into
  `plugin_storage` and drop the old plugin-specific source/config tables.
- The shared HTTP source package exists as `@executor-js/plugin-http-source`.

The React layer still intentionally composes the existing shared credential
components instead of replacing whole source forms with generated UIs. That
keeps MCP stdio out of HTTP-specific components while making header/query/OAuth
credential changes land in shared components used by OpenAPI, GraphQL, and MCP
HTTP.

- User-scoped connections.

The resulting access token may be placed in a header or query parameter, but the
OAuth lifecycle is richer than raw header configuration.

Avoid double nesting:

```ts
oauth2: {
  oauth2: {
    // ...
  },
}
```

Prefer one OAuth object at the HTTP credential boundary:

```ts
request: {
  oauth: {
    clientId: SecretId.make("client_id"),
    clientSecret: SecretId.make("client_secret"),
    authorizationUrl: "https://example.com/oauth/authorize",
    tokenUrl: "https://example.com/oauth/token",
    scopes: ["read", "write"],
    placement: {
      header: "Authorization",
      scheme: "Bearer",
    },
  },
}
```

## Slot Manifest

Persist source config, derive manifests from it.

The manifest is for UI/status/validation. It should not be the source of truth
if it can be derived from plugin-owned config.

Example derived manifest entry:

```ts
{
  slotKey: "request.headers.authorization",
  label: "Authorization",
  family: "http.header",
  required: true,
  valueKind: "secret",
  placement: {
    header: "Authorization",
    prefix: "Bearer ",
  },
}
```

Core may expose generic manifest/query APIs, but it should not interpret
`family: "http.header"` beyond using it as metadata. The HTTP package and UI
components interpret HTTP metadata.

## React/UI Direction

Use composition, not a mega-form with many boolean props.

Avoid:

```tsx
<CredentialForm isOpenApi isGraphql={false} hasSpecFetch hasOAuth hasQuery hasHeaders />
```

Prefer plugin forms composed from shared sections:

```tsx
<OpenApiConfigureForm>
  <HttpCredentials.Section field="request" title="Request" />
  <HttpCredentials.Section field="specFetch" title="Spec fetch" />
  <OAuthCredentials.Section field="request.oauth" />
</OpenApiConfigureForm>
```

```tsx
<GraphqlConfigureForm>
  <HttpCredentials.Section field="request" title="Request" />
</GraphqlConfigureForm>
```

```tsx
<McpHttpConfigureForm>
  <HttpCredentials.Section field="request" title="Request" />
</McpHttpConfigureForm>
```

MCP stdio can be omitted from shared HTTP components for now. It should later
compose process/env components instead of forcing itself through the HTTP
credential UI.

Shared UI pieces likely include:

- `CredentialValueInput`
- `SecretPicker`
- `ConnectionPicker`
- `HttpHeaderCredentials`
- `HttpQueryCredentials`
- `OAuthCredentials`
- `CredentialStatusList`
- `SourceConfigureProvider`

The generic UI mutation should call:

```ts
configureSource(source, input);
```

Plugin forms produce typed configure payloads.

## MCP Notes

MCP stdio causes code-sharing problems if MCP is treated as one credential
family. The sharing boundary should be transport-level:

- OpenAPI, GraphQL, and MCP HTTP share HTTP credential helpers.
- MCP stdio and future CLI sources should share process/env helpers later.
- Databases should have their own connection helper family later.

It is acceptable for MCP add/import to require auth if the server needs auth to
list tools. Longer term, MCP may need scoped/auth-derived tool metadata because
some servers expose different tools/descriptions based on auth state.

This overhaul does not need to solve scoped MCP metadata fully, but it should
avoid baking in an assumption that one global tool manifest is always correct.

## Migration Plan

This is a one-shot migration that preserves existing config and values.

Migration responsibilities:

1. Move concrete credential values into `credential_binding` if any remain in
   plugin-specific tables/JSON.
2. Move source declaration/config into plugin-owned JSON config.
3. Preserve source IDs, names, scopes, base URLs, specs, endpoints, transports,
   and tool relationships.
4. Preserve OAuth connections and client credentials.
5. Drop or ignore old plugin-specific child tables after data is migrated.

Tests should cover:

- OpenAPI header/query/spec-fetch migration.
- OpenAPI OAuth/client credential migration.
- GraphQL header/query/auth migration.
- MCP HTTP header/query/auth migration.
- MCP stdio source survival.
- Collision detection where legacy slot canonicalization would collapse names.
- Existing source listing and tool invocation after migration.
- Secret/connection usage isolation after migration.

## Implementation Order

Even in one large PR, sequence the work internally:

1. Document the architecture and update the existing notes.
2. Add/finish core source binding and configure registry.
3. Add generic plugin storage table/provider if not already present.
4. Create `@executor-js/plugin-http-source`.
5. Port OpenAPI to configure + HTTP helpers + JSON source config.
6. Port GraphQL to configure + HTTP helpers + JSON source config.
7. Port MCP with transport-discriminated configure.
8. Replace React credential flows with composed shared components.
9. Add one-shot migrations and migration tests.
10. Delete old plugin-specific binding APIs, stores, tables, atoms, and helpers.
11. Run full verification and fix fallout.

## Success Criteria

- Normal SDK users configure credentials through plugin-native configure APIs.
- Generic UI can call `executor.sources.configure(...)`.
- Core does not expose headers/query/OAuth as universal source concepts.
- OpenAPI/GraphQL/MCP do not each implement their own binding resolver/lister.
- HTTP credential UI changes apply to OpenAPI, GraphQL, and MCP HTTP.
- Plugin storage remains overridable and is backed by one shared plugin storage
  table for plugin-private data.
- Source config remains first-class enough for source listing, tools, policies,
  refresh, and scopes.
- Old plugin-specific credential child tables and endpoints are gone.

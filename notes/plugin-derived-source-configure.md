# Plugin-Derived Source Configure Notes

Date: 2026-05-17
Status: planning

## Summary

`executor.sources.configure(...)` can exist without making headers, query
params, OAuth, database passwords, CLI env vars, or any other protocol-specific
concept part of core.

The key distinction:

- Core owns source identity, scoped binding storage, resolution, validation, and
  dispatch.
- Plugins own their configure schemas and the translation from configure input
  to core bindings.
- Shared UI lives in reusable plugin-family components, not in core source
  semantics.

This means `executor.openapi.configure(...)` and
`executor.graphql.configure(...)` can remain the typed plugin-native APIs, while
`executor.sources.configure(...)` becomes a generic dispatcher derived from the
installed plugin implementations.

## Why Not Put Headers In Core

Core needs to support many source types:

- OpenAPI and GraphQL over HTTP.
- MCP over HTTP or stdio.
- Databases.
- CLIs.
- Future source types we have not named yet.

Only some of these have request headers, query params, or OAuth. A database
source may have a connection string, username, password, TLS certs, and schema
selection. A CLI source may have env vars, argv templates, working directory,
and stdin. If core's public configure model says `headers` and `query`, it is
quietly HTTP-specific.

Core's portable primitive is still:

```ts
{
  source: { id, scope },
  scope,
  slot,
  value,
}
```

where the owning plugin defines what `slot` means.

## Desired API Shape

Plugin APIs remain first-class:

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

The generic source API is derived from those plugin implementations:

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

The `type` discriminant is for dispatch and type narrowing. The actual source
record should still be checked so callers cannot configure an OpenAPI source
with a GraphQL payload.

```ts
const storedSource = yield * sources.get(source);

if (storedSource.type !== input.type) {
  return (
    yield *
    Effect.fail(
      new SourceTypeMismatch({
        source,
        expected: storedSource.type,
        received: input.type,
      }),
    )
  );
}
```

## Registration Model

Each plugin registers its configure implementation with core:

```ts
openapiPlugin.registerSourceConfigure({
  type: "openapi",
  schema: OpenApiConfigureInput,
  configure: openApiConfigure,
});
```

```ts
graphqlPlugin.registerSourceConfigure({
  type: "graphql",
  schema: GraphqlConfigureInput,
  configure: graphqlConfigure,
});
```

Core dispatch stays small:

```ts
const configure = (source, input) =>
  Effect.gen(function* () {
    const storedSource = yield* Sources.get(source);
    const implementation = yield* SourceConfigureRegistry.get(input.type);

    if (storedSource.type !== input.type) {
      return yield* Effect.fail(
        new SourceTypeMismatch({
          source,
          expected: storedSource.type,
          received: input.type,
        }),
      );
    }

    const parsed = yield* Schema.decodeUnknown(implementation.schema)(input);

    return yield* implementation.configure(source, parsed);
  });
```

The plugin implementation compiles its domain-specific configure input into
core binding operations:

```ts
const openApiConfigure = (source, input) =>
  Effect.gen(function* () {
    const bindings = yield* compileOpenApiConfigureBindings(source, input);

    yield* Sources.replaceBindings({
      source,
      scope: input.scope,
      bindings,
    });
  });
```

## Shared HTTP Credential Pieces

OpenAPI, GraphQL, and HTTP MCP should reuse HTTP credential vocabulary, but
that vocabulary should live in a shared protocol helper, not core.

```ts
type HttpRequestCredentialConfig = {
  headers?: Record<string, CredentialInput>;
  query?: Record<string, CredentialInput>;
  oauth?: OAuthCredentialConfig;
};
```

Then plugins embed that helper where it makes sense:

```ts
type OpenApiConfigureInput = {
  type: "openapi";
  scope: ScopeId;
  request?: HttpRequestCredentialConfig;
  specFetch?: HttpRequestCredentialConfig;
};
```

```ts
type GraphqlConfigureInput = {
  type: "graphql";
  scope: ScopeId;
  request?: HttpRequestCredentialConfig;
  introspection?: HttpRequestCredentialConfig;
};
```

```ts
type HttpMcpConfigureInput = {
  type: "mcp";
  scope: ScopeId;
  request?: HttpRequestCredentialConfig;
};
```

Database and CLI plugins should not see this shape unless they opt into it.

## Shared UI Direction

The generic UI should call one mutation:

```ts
configureSource(source, input);
```

but forms should be plugin-specific or plugin-family-specific.

HTTP-ish plugins can share components:

```tsx
<HttpRequestCredentialsForm
  value={config.request}
  onChange={(request) => setConfig({ ...config, request })}
/>
```

OpenAPI can use it twice:

```tsx
<HttpRequestCredentialsForm field="request" />
<HttpRequestCredentialsForm field="specFetch" />
```

GraphQL can use it for request and introspection credentials:

```tsx
<HttpRequestCredentialsForm field="request" />
<HttpRequestCredentialsForm field="introspection" />
```

MCP HTTP can use it for its request transport credentials:

```tsx
<HttpRequestCredentialsForm field="request" />
```

Other source families get their own shared components:

```tsx
<DatabaseConnectionCredentialsForm />
<CliEnvironmentBindingsForm />
```

The reuse boundary is therefore explicit:

- Core mutation and atoms are shared.
- Plugin configure schemas are plugin-owned.
- HTTP credential UI is shared only by plugins that use HTTP credential shapes.
- Database and CLI UI are not forced through HTTP concepts.

## OAuth Notes

OAuth should be part of the HTTP credential helper, but it should not be modeled
as just another header value. OAuth configuration needs room for:

- Authorization URL.
- Token URL.
- Client ID.
- Client secret.
- Scopes.
- PKCE and auth-code state.
- Refresh behavior.
- Token placement after exchange.

The resulting access token may be placed into a header or query param, but the
configuration and lifecycle are richer than a raw `Authorization` binding.

Avoid double nesting like:

```ts
oauth2: {
  oauth2: {
    ...
  },
}
```

Prefer a single OAuth object embedded at the credential boundary:

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

## MCP And Auth-Dependent Metadata

MCP can expose different tool descriptions depending on auth state. GraphQL can
also theoretically expose different introspection results by credential scope.

This does not invalidate the shared configure dispatch model, but it means the
plugin must decide whether metadata is global source shape or scoped resolved
shape.

For MCP especially, avoid assuming a single globally cached tool manifest per
source forever. A future MCP implementation may need:

- shared source transport config;
- scoped credential bindings;
- scoped or credential-derived tool metadata cache.

That is plugin behavior, not core binding behavior.

## Design Guardrails

- Do not add `headers`, `query`, or `oauth` as universal core source fields.
- Do keep `executor.openapi.configure` and other plugin-native configure APIs.
- Do derive `executor.sources.configure` from registered plugin implementations.
- Do validate that `input.type` matches the stored source type.
- Do compile plugin configure input into core binding writes internally.
- Do build shared React components around explicit plugin-family shapes such as
  HTTP request credentials.
- Do not require database, CLI, or future non-HTTP sources to fit the HTTP
  credential model.

## Likely Implementation Order

1. Keep core binding APIs protocol-agnostic.
2. Make OpenAPI's configure implementation compile to those core bindings.
3. Introduce source-level configure dispatch over registered plugin configure
   implementations.
4. Move OpenAPI UI to the generic configure mutation while keeping OpenAPI's
   form domain-specific.
5. Extract shared HTTP credential config types and UI components when GraphQL or
   MCP is ported, rather than abstracting from OpenAPI alone.

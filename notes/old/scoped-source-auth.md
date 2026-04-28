# Scoped source auth and plugin-owned overrides

Working model for shared sources with personal/workspace/org auth.

## Problem

Sources can be shared at an outer scope while auth often belongs at an
inner scope.

Examples:

- An organization adds an OpenAPI source once, but every member brings
  their own API token or OAuth client credentials.
- A workspace shares one connection by default, but an individual user
  overrides it with their own connection.
- A future policy says an org only allows low-risk operations to auto-run,
  while a user or workspace has a narrower or broader typed policy.

The common primitive is not "org auth" or "user auth". It is an ordered
scope stack:

```ts
[user, workspace, org]
```

Rows still belong to exactly one scope. Resolution walks the stack
innermost first, with outer scopes acting as shared defaults.

## Boundary

Core owns generic primitives:

- Scope stack and scope ids.
- Source registry metadata: id, owning scope, plugin id, display fields.
- Secrets and connections.
- Tool invocation enforcement once a plugin reports annotations/policy.

Plugins own source-domain meaning:

- How a source authenticates.
- What auth slots exist.
- How slots are used during invocation.
- Per-source/per-scope config patches.
- Per-source/per-scope policy rules.

Do not put plugin-specific config into a generic core JSON bag. Core
should not know that an OpenAPI source uses an Authorization header, that
an OAuth flow is client credentials, or that `GET` operations are safer
than `POST` operations. Those are plugin concerns.

## OpenAPI model

OpenAPI has a typed base source row:

```ts
openapi_source {
  id
  scope_id
  spec
  base_url
  headers // static strings or typed slot references
  oauth2  // typed OAuth template with slot ids
}
```

The source row describes the template, not a globally connected account.
For example:

```ts
oauth2: {
  flow: "clientCredentials",
  tokenUrl,
  clientIdSlot,
  clientSecretSlot,
  connectionSlot,
  scopes
}
```

Scoped auth material lives in OpenAPI-owned rows:

```ts
openapi_source_binding {
  source_id
  source_scope_id
  target_scope_id
  slot
  value: { kind: "secret", secretId }
       | { kind: "connection", connectionId }
       | { kind: "text", text }
}
```

The storage column is intentionally `target_scope_id`, not `scope_id`.
This keeps the table out of the SDK scoped-adapter convention, because a
source owner must be able to clean up all bindings for that source even
when some bindings target descendant user scopes. OpenAPI still filters
and validates visibility manually against the active scope stack.

OpenAPI resolves bindings across the current scope stack. The plugin then
uses its typed source config to decide how the resolved material is
applied. For example, a slot may become an HTTP header with a prefix, or
an OAuth connection may provide a bearer token.

Core is only involved when resolving the underlying primitive:

```ts
const binding = await openapiStore.resolveSourceBinding(source, slot);

if (binding.value.kind === "secret") {
  const value = await ctx.secrets.get(binding.value.secretId);
}

if (binding.value.kind === "connection") {
  const token = await ctx.connections.accessToken(binding.value.connectionId);
}
```

## Add-source UX

Adding a source and adding auth should be separable.

Expected flow:

1. Admin adds a source at an outer scope.
2. Admin chooses the auth template the source supports.
3. Source can be saved without entering secret values or completing OAuth.
4. Users or workspace admins later fill the auth slots at the scope they
   want to own.
5. Invocation resolves the innermost matching binding.

This avoids making the first person who adds a source accidentally
provide auth for everyone.

## OAuth flows

Authorization code and client credentials use the same slot model.

Authorization code:

```ts
source oauth template:
  clientIdSlot
  clientSecretSlot?
  connectionSlot

user bindings:
  clientIdSlot -> shared or personal client id secret
  clientSecretSlot -> shared or personal client secret secret
  connectionSlot -> user's Connection
```

Client credentials:

```ts
source oauth template:
  clientIdSlot
  clientSecretSlot
  connectionSlot

user bindings:
  clientIdSlot -> user's client id secret
  clientSecretSlot -> user's client secret secret
  connectionSlot -> user's app-style Connection
```

`Connection.kind` remains a core concept because it describes the
connection/token identity. The pointer from a source auth slot to a
connection is plugin-owned scoped data.

## MCP direction

MCP should follow the same shape when it needs shared source plus
personal auth:

- MCP source row owns the typed auth template.
- MCP plugin owns scoped auth binding/config rows.
- Core connections/secrets remain the underlying primitives.
- Invocation resolves through the plugin-owned scoped rows.

Do not make MCP depend on OpenAPI's binding table. The shared abstraction
is the scope stack and the helper patterns, not a cross-plugin table that
contains plugin semantics.

## Policy direction

Auto-run/approval policy should not be stored as generic source override
JSON.

Core should enforce the final invocation decision, but plugins should own
typed policy rules when the rule language is domain-specific. For
OpenAPI, a policy may mention HTTP methods or operation ids. For MCP, it
may mention MCP tool metadata. Those meanings are not core concepts.

Shape:

```ts
plugin scoped config/policy rows:
  source_id
  source_scope_id
  target_scope_id // or another plugin-owned scope field, not core magic
  typed plugin policy fields

plugin.resolveAnnotations(tool, scopeStack):
  derive ToolAnnotations from plugin-owned rows

core invoke:
  enforce ToolAnnotations
```

## What not to do

- Do not add a generic `source_override.value` JSON blob in core for
  plugin config.
- Do not store effective plugin config twice, once in plugin tables and
  once in core.
- Do not make slot names meaningful to core.
- Do not bake user/org/workspace concepts into SDK storage. Scope ids are
  flat; the host builds the ordered stack per request.

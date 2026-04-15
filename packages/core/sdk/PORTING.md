# @executor/sdk plugin porting guide

This is the plugin-author contract for the new SDK shape. Read it end-to-end
before touching a plugin; the old shape and the new shape are different enough
that a blind port will lose features.

The running reference implementation is
[`src/executor.test.ts`](./src/executor.test.ts) — a ~300-line self-contained
plugin that exercises every surface described below. When in doubt, match that
file's patterns.

## TL;DR: what changed

| Old SDK | New SDK |
| --- | --- |
| `ExecutorPlugin<K, Ext>` with `init(ctx): Effect<PluginHandle>` | `definePlugin(() => PluginSpec)` factory returning a plain spec |
| `PluginContext` with `ctx.tools`, `ctx.sources`, `ctx.secrets`, `ctx.policies` services | `PluginCtx<TStore>` with `ctx.storage`, `ctx.core`, `ctx.secrets` facade, `ctx.transaction` |
| `ctx.tools.registerInvoker(key, invoker)` | `plugin.invokeTool({ ctx, toolRow, args, elicit })` |
| `ctx.sources.addManager({ kind, list, remove, detect, refresh })` | `plugin.removeSource` / `plugin.refreshSource` lifecycle hooks; `list` is just a direct core-table query |
| `registerRuntimeTools` / `runtimeTool` | `plugin.staticSources(self)` — declarative, in-memory, no DB writes |
| `ctx.tools.register([ToolRegistration[]])` | `ctx.core.sources.register({ id, tools: [...] })` |
| `ctx.tools.registerDefinitions(defs)` | `ctx.core.definitions.register({ sourceId, definitions })` |
| `ScopedKv` per plugin | Plugin declares its own `schema` + typed store via `storage: (deps) => ...` |
| `makeInMemoryToolRegistry()` etc. passed into `ExecutorConfig` | `ExecutorConfig = { scope, adapter, blobs, plugins }` — no service registries |
| `ToolInvoker.resolveAnnotations(toolId)` | `plugin.resolveAnnotations({ ctx, sourceId, toolRows })` — bulk resolver |
| `executor.tools.invoke(id, args, { onElicitation })` — still the same shape | `executor.tools.invoke(id, args, { onElicitation })` — but options now thread `elicit` into the handler |
| `ToolAnnotations` stored on the tool row | Derived at read time from plugin storage. Never persisted. |

## Plugin shape

```ts
import { definePlugin, type ToolRow } from "@executor/sdk";

export const myPlugin = definePlugin(
  (options?: MyPluginOptions) => ({
    id: "my-plugin" as const,
    schema: mySchema,
    storage: (deps) => makeMyStore(deps.adapter, deps.blobs),

    // ⚠️  Field ORDER matters — `extension` MUST appear before
    // `staticSources` so TypeScript infers TExtension from `extension`'s
    // return type, then NoInfer<TExtension> locks `self` in staticSources
    // to that inferred shape.
    extension: (ctx) => ({
      doThing: (input) => ctx.transaction(/* ... */),
      listThings: () => ctx.storage.listAll(),
    }),

    staticSources: (self) => [
      {
        id: "my-plugin.control",
        kind: "control",
        name: "My Plugin",
        tools: [
          {
            name: "doThing",
            description: "Do a thing",
            inputSchema: { type: "object", properties: { /* ... */ } },
            annotations: { requiresApproval: false },
            handler: ({ args }) => self.doThing(args as DoThingInput),
          },
        ],
      },
    ],

    invokeTool: ({ ctx, toolRow, args, elicit }) =>
      Effect.gen(function* () {
        // Look up plugin enrichment by toolRow.id (same as the old
        // ToolInvoker.invoke pattern)
        const binding = yield* ctx.storage.getBinding(toolRow.id);
        // ... call elicit(...) if you need user input mid-invoke ...
        return result;
      }),

    resolveAnnotations: ({ ctx, sourceId, toolRows }) =>
      Effect.gen(function* () {
        // Bulk-compute annotations from your own storage. Called at
        // invoke time (single row) AND list time (every row under a
        // source). One storage lookup per source is ideal.
        const bindings = yield* ctx.storage.getBindingsForSource(sourceId);
        const out: Record<string, ToolAnnotations> = {};
        for (const row of toolRows) {
          const binding = bindings.get(row.id);
          if (binding) out[row.id] = annotationsFor(binding);
        }
        return out;
      }),

    removeSource: ({ ctx, sourceId }) =>
      ctx.storage.removeSource(sourceId),

    refreshSource: ({ ctx, sourceId }) =>
      ctx.storage.refreshSource(sourceId),

    secretProviders: (ctx) => [makeMyProvider(ctx)],
  }),
);
```

## The eight fields of `PluginSpec`

### `id` (required)

The plugin's unique identifier. Becomes a property on the Executor
(`executor[pluginId]`) carrying whatever `extension` returns. Must be a string
literal type (`"my-plugin" as const`) so it surfaces on the typed executor.

### `schema` (optional)

Plugin-declared `DBSchema` that gets merged with `coreSchema` and every other
plugin's schema at executor startup via `collectSchemas(plugins)`. Tables
declared here are available via `ctx.storage`'s underlying adapter; the
executor never touches them.

Use `satisfies DBSchema` with `as const` so TypeScript preserves the literal
shape for `typedAdapter<typeof mySchema>`:

```ts
import type { DBSchema } from "@executor/sdk";

export const mySchema = {
  my_plugin_binding: {
    modelName: "my_plugin_binding",
    fields: {
      id: { type: "string", required: true },
      source_id: { type: "string", required: true, index: true },
      binding: { type: "json", required: true },
      created_at: { type: "date", required: true },
    },
  },
} as const satisfies DBSchema;

export type MyPluginSchema = typeof mySchema;
```

### `storage` (required)

Factory from `StorageDeps` (`{ scope, adapter, blobs }`) to a typed store
object. This is the **only place a plugin ever sees a raw adapter or raw
blob store.** Everything else in the plugin works through `ctx.storage`.

Pattern: wrap the raw adapter with `typedAdapter<MySchema>(deps.adapter)` at
the top of the factory to get narrowed `model` names and typed rows.

```ts
import { typedAdapter } from "@executor/sdk";

export const makeMyStore = (adapter: DBAdapter, blobs: ScopedBlobStore): MyStore => {
  const db = typedAdapter<MyPluginSchema>(adapter);
  return {
    writeBinding: (id, binding) =>
      db.create({
        model: "my_plugin_binding",
        data: { id, source_id: sourceId, binding, created_at: new Date() },
        forceAllowId: true,
      }).pipe(Effect.asVoid),
    // ...
  };
};
```

### `extension` (optional)

`(ctx: PluginCtx<TStore>) => TExtension`. Whatever this returns becomes
`executor[pluginId]`. Also passed as `self` to `staticSources` so control tool
handlers can delegate to the plugin's real API in one line.

Use `ctx.transaction(effect)` when an extension method does multiple writes
that must succeed or fail as a unit:

```ts
addSpec: (config) =>
  ctx.transaction(
    Effect.gen(function* () {
      const parsed = yield* parse(config.spec);
      yield* ctx.storage.upsertSource(parsed);
      yield* ctx.core.sources.register({ id: parsed.namespace, /* ... */ });
      yield* ctx.core.definitions.register({ sourceId: parsed.namespace, definitions: parsed.defs });
    }),
  ),
```

**⚠️  `ctx.core.sources.register` is not currently idempotent** — calling it
twice with the same source id will error on real SQL backends. Plugins that
need to re-run a registration should call `ctx.core.sources.unregister` first.
This is a known follow-up (see the TODO in `executor.ts`).

### `staticSources` (optional)

`(self: NoInfer<TExtension>) => readonly StaticSourceDecl[]`. Static sources
are the replacement for the old runtime-tools system. They live **entirely in
an in-memory map** built at executor startup — no DB writes, no stale rows when
the plugin's declaration changes.

Use them for **control tools** (`previewSpec`, `addSource`, `connect`) that
are always present and defined in plugin code. Each static tool has an inline
handler that can close over `self` to call the plugin's own extension API.

Static tool handlers receive `{ ctx, args, elicit }`. They can't take arbitrary
closures from the plugin — they only see the inputs the executor provides.

**Static source ids and tool ids are in the same namespace as dynamic ones.**
The executor rejects dynamic-source registrations that would collide with a
static id.

### `invokeTool` (optional)

`({ ctx, toolRow, args, elicit }) => Effect<unknown, Error>`. Called when
`executor.tools.invoke(toolId, args)` hits a tool row that's **not** in the
static map — i.e., user-added/dynamic tools.

The executor **already loaded the tool row** and hands it to you with
`toolRow.id`, `toolRow.source_id`, `toolRow.name`, `toolRow.input_schema`, etc.
Don't parse `toolRow.id` — use the structured fields. Use `toolRow.id` as an
opaque lookup key against your plugin storage when you need to fetch
enrichment (like OpenAPI's `OperationBinding`).

```ts
invokeTool: ({ ctx, toolRow, args, elicit }) =>
  Effect.gen(function* () {
    // ✅ Opaque-id lookup against plugin storage (OpenAPI pattern)
    const binding = yield* ctx.storage.getBinding(toolRow.id);

    // ✅ Structured field access (simpler plugins)
    //    toolRow.source_id === the source's id the plugin used in `register`
    //    toolRow.name      === the `name` field from SourceInputTool

    // ❌ NEVER do this
    // const [, thingId, methodName] = toolRow.id.split(".");
    //
    // Tool names can contain dots (`dns.records.create`) and the id
    // contains the source id too. Parsing on dots is broken.
  }),
```

### `resolveAnnotations` (optional)

`({ ctx, sourceId, toolRows }) => Effect<Record<toolId, ToolAnnotations>>`.

**Bulk** resolver for default-policy metadata: `requiresApproval`,
`approvalDescription`, `mayElicit`. Called by the executor:
- at **invoke time** with a single-element `toolRows` array, to enforce
  approval before running the tool
- at **list time** with every dynamic tool row grouped by `(plugin, source)`,
  to populate `Tool.annotations` for UI

**Annotations are not persisted.** They're derived every time from your
plugin storage. If your annotation rules change, the next invoke / next list
picks up the new behaviour with zero migration. The trade-off is that your
resolver should be cheap — ideally one storage read per source, not per row.
Most plugins already need to read the per-source binding data for invoke
anyway, so this is free.

```ts
resolveAnnotations: ({ ctx, sourceId, toolRows }) =>
  Effect.gen(function* () {
    // One query for everything under this source:
    const bindingsBySource = yield* ctx.storage.findBindingsByToolIds(
      toolRows.map((r) => r.id),
    );
    const out: Record<string, ToolAnnotations> = {};
    for (const row of toolRows) {
      const binding = bindingsBySource[row.id];
      if (binding) {
        out[row.id] = annotationsFor(binding.method, binding.pathTemplate);
      }
    }
    return out;
  }),
```

Omit `resolveAnnotations` entirely if the plugin has nothing to contribute —
its tools will be treated as auto-approved with no elicitation hint.

### `removeSource` / `refreshSource` (optional)

`({ ctx, sourceId }) => Effect<void, Error>`. Lifecycle hooks called by the
executor when `executor.sources.remove(id)` or `executor.sources.refresh(id)`
target a source owned by this plugin. The executor wraps them in a transaction
alongside the core-table cleanup.

Plugin-side cleanup only — you don't need to delete from the `source`, `tool`,
or `definition` tables yourself. The executor handles that after your hook
returns.

### `secretProviders` (optional)

`readonly SecretProvider[] | ((ctx) => readonly SecretProvider[])`.

Plugins that contribute secret providers (keychain, file-secrets, onepassword,
workos-vault) declare them here. Providers are registered once at executor
startup; there's no runtime registration. Use the function form if your
provider needs per-instance state derived from `ctx.scope` (e.g., keychain
needs a scope-derived service name).

See [secrets](#secrets) below for the provider interface.

### `close` (optional)

`() => Effect<void, Error>`. Called when the executor shuts down. Close
transports, release file handles, etc.

## Core writes: `ctx.core.sources.register`

This is the **only** place a plugin writes a dynamic source + its tools. Old
code that called `ctx.tools.register([toolRegistration])` directly is gone —
tools always belong to a source, and they're written as a set.

```ts
yield* ctx.core.sources.register({
  id: "cloudflare",          // source id — also the user-facing name
  kind: "openapi",           // plugin-specific kind (displayed in UI)
  name: "Cloudflare API",
  url: "https://api.cloudflare.com/client/v4",
  canRemove: true,           // most dynamic sources are removable
  canRefresh: true,          // if your plugin supports refresh
  canEdit: true,             // if your plugin has an updateSource method
  tools: operationDefs.map((op) => ({
    name: op.toolPath,       // "dns.records.create" is fine — dots allowed
    description: op.description,
    inputSchema: op.inputSchema,   // JSON schema, may carry $ref: "#/$defs/X"
    outputSchema: op.outputSchema, // same
    // No `annotations` — those come from resolveAnnotations at read time
  })),
});
```

**Tool ids are `${source.id}.${tool.name}`.** The executor constructs them;
you never build them yourself. They're opaque strings — no code anywhere
splits them.

### `ctx.core.definitions.register`

For shared JSON-schema `$defs` (OpenAPI `components.schemas`, for example).
Tool schemas registered above can carry `$ref: "#/$defs/X"` pointers; the
executor's `tools.schema(toolId)` read path attaches matching defs from this
table onto the returned schema.

Call inside the same `ctx.transaction` as `sources.register` so a failed add
rolls back both:

```ts
yield* ctx.transaction(
  Effect.gen(function* () {
    yield* ctx.storage.upsertPluginRows(/* ... */);
    yield* ctx.core.sources.register({ id: namespace, /* ... */ });
    yield* ctx.core.definitions.register({
      sourceId: namespace,
      definitions: hoistedDefs, // Record<string, JsonSchemaFragment>
    });
  }),
);
```

Deleting a source cascades to its definitions automatically — you don't need
to call `unregister` on definitions separately.

## Elicitation

Plugins that need to ask the user something mid-invoke (1Password unlock
prompts, interactive MCP tools, OAuth device-flow codes) receive an `elicit`
function on their handler input. It suspends the fiber, calls the host's
elicitation handler (passed via `executor.tools.invoke(id, args, { onElicitation })`),
and resumes with the response.

```ts
import { FormElicitation } from "@executor/sdk";

invokeTool: ({ ctx, toolRow, args, elicit }) =>
  Effect.gen(function* () {
    const response = yield* elicit(
      new FormElicitation({
        message: "Enter your 1Password master password",
        requestedSchema: {
          type: "object",
          properties: { password: { type: "string", format: "password" } },
          required: ["password"],
        },
      }),
    );
    // response.action is "accept" here — "decline"/"cancel" propagate as
    // ElicitationDeclinedError from elicit() and short-circuit the handler.
    const { password } = response.content as { password: string };
    // ... use password ...
  }),
```

Same `elicit` is available on static tool handlers.

For URL-based flows (OAuth popups, browser-based approval pages), use
`UrlElicitation`:

```ts
yield* elicit(
  new UrlElicitation({
    message: "Approve access in your browser",
    url: authorizationUrl,
    elicitationId: sessionId,
  }),
);
```

## Secrets

### The provider interface

```ts
export interface SecretProvider {
  readonly key: string;              // "keychain", "file", "memory", etc.
  readonly writable: boolean;        // false for env / 1password
  readonly get: (id: string) => Effect<string | null, Error>;
  readonly set?: (id: string, value: string) => Effect<void, Error>;
  readonly delete?: (id: string) => Effect<boolean, Error>;
  readonly list?: () => Effect<readonly { id: string; name: string }[], Error>;
}
```

The executor routes `executor.secrets.get(id)` through the core `secret`
table to find the pinned provider, then calls `provider.get(id)`. **No
provider walking.** If a secret id isn't in the core table, it doesn't exist
from the executor's perspective — even if a provider would happen to return
a value for it. This means every secret the executor knows about has been
explicitly registered through `executor.secrets.set(input)`, which writes both
the value to the provider and the routing row.

### For plugins that consume secrets

Inside `invokeTool` and extension methods, read via `ctx.secrets.get(id)`:

```ts
const token = yield* ctx.secrets.get(headerValue.secretId);
if (token === null) {
  return yield* Effect.fail(new Error(`Missing secret: ${headerValue.secretId}`));
}
```

### For plugins that contribute providers

Return them from `plugin.secretProviders`:

```ts
secretProviders: (ctx) => [
  {
    key: "my-provider",
    writable: true,
    get: (id) => /* ... */,
    set: (id, value) => /* ... */,
    delete: (id) => /* ... */,
    list: () => /* ... */,
  },
],
```

If your provider needs state derived from ctx (keychain's scope-prefixed
service name), use the function form. Otherwise a static array is fine.

## Testing

Every plugin gets a test file that uses `makeTestConfig` to spin up an
executor with an in-memory adapter and in-memory blob store:

```ts
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { createExecutor, makeTestConfig } from "@executor/sdk";
import { myPlugin } from "./plugin";

describe("myPlugin", () => {
  it.effect("does the thing", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [myPlugin()] as const }),
      );
      const result = yield* executor["my-plugin"].doThing("input");
      expect(result).toBe("expected");
    }),
  );
});
```

### Testing elicitation

Pass a handler via `InvokeOptions`:

```ts
const result = yield* executor.tools.invoke(
  "my-plugin.interactive",
  {},
  {
    onElicitation: (input) =>
      Effect.succeed(
        new ElicitationResponse({
          action: "accept",
          content: { password: "test-password" },
        }),
      ),
  },
);
```

For tests that don't care about approval gating, `onElicitation: "accept-all"`
is a sentinel that auto-accepts every request.

### Testing secrets

If your plugin needs a secret during a test, register a trivial in-memory
secret provider plugin alongside yours:

```ts
import { definePlugin, type SecretProvider } from "@executor/sdk";

const memoryProvider: SecretProvider = (() => {
  const store = new Map<string, string>();
  return {
    key: "memory",
    writable: true,
    get: (id) => Effect.sync(() => store.get(id) ?? null),
    set: (id, value) => Effect.sync(() => { store.set(id, value); }),
    delete: (id) => Effect.sync(() => store.delete(id)),
    list: () => Effect.sync(() =>
      Array.from(store.keys()).map((id) => ({ id, name: id })),
    ),
  };
})();

const memorySecretsPlugin = definePlugin(() => ({
  id: "memory-secrets" as const,
  storage: () => ({}),
  secretProviders: [memoryProvider],
}));
```

## Anti-patterns and gotchas

### ❌ Do not split `toolRow.id`

```ts
// BROKEN — tool names can contain dots
const [, thingId, methodName] = toolRow.id.split(".");
```

Use `toolRow.source_id` and `toolRow.name` — both are real columns on the
row, pre-extracted by the executor at registration time. For plugin-stored
enrichment, use `toolRow.id` as an opaque lookup key.

### ❌ Do not build tool ids yourself

```ts
// BROKEN — executor owns the id format
const toolId = `${pluginKey}.${sourceId}.${toolName}`;
```

Pass `{ name: "doThing" }` to `ctx.core.sources.register`; the executor
generates the tool id as `${source.id}.${name}`.

### ❌ Do not reach for `ctx.adapter` in `extension` or `invokeTool`

The raw adapter is only passed into `storage: (deps) => ...`. Once you're
inside an extension or an invoke handler, you go through `ctx.storage` (your
own typed store). This is the seam that keeps plugin data out of the core
tables and vice versa.

### ❌ Do not persist annotations on rows

Annotations are derived at read time via `plugin.resolveAnnotations`. If you
find yourself adding an `annotations` column to a plugin schema, you're
solving the wrong problem — compute them from the data that already drives
your tool's behaviour.

### ❌ Do not write static sources to `ctx.core.sources.register`

Static sources are declared via the `staticSources` field and live in
memory only. Writing them to the DB would mean running the same upsert on
every boot, plus stale rows when the plugin's declaration changes. The
executor rejects dynamic registrations that would collide with a static id.

### ❌ Do not call `ctx.secrets.set` for reading

`ctx.secrets.get(id)` for reads, `executor.secrets.set(input)` for writes
(not on ctx — writes go through the executor surface, not the plugin ctx,
because they mutate the core `secret` table and that's owned by the host,
not any individual plugin).

### ❌ Do not use `Option` types in storage row shapes

JSON-column round-tripping through the adapter doesn't preserve Effect
`Option` instances. If your plugin has `Schema.Class` types with
`Schema.optionalWith(..., { as: "Option" })`, either:
- Use `Schema.encode`/`Schema.decodeUnknown` at the storage boundary to
  convert between `Option<T>` and raw JSON on write/read
- Or store plain `T | undefined` in the row and wrap in `Option.fromNullable`
  when you need the Schema shape

See `plugins/openapi/src/sdk/store.ts` for the encode/decode pattern.

## Porting from the old shape

If you're porting an existing plugin from the pre-rewrite SDK, the mapping is:

| Old call | New call |
| --- | --- |
| `plugin.init(ctx)` returns a `PluginHandle` | `definePlugin(() => ({ id, storage, extension, ... }))` |
| `ctx.tools.registerInvoker(key, invoker)` | `plugin.invokeTool: ({ ctx, toolRow, args, elicit }) => ...` |
| `ctx.tools.register([ToolRegistration[]])` | `ctx.core.sources.register({ id, tools: [...] })` |
| `ctx.tools.unregister([toolIds])` | `ctx.core.sources.unregister(sourceId)` (unregister by source, not by tool) |
| `ctx.tools.unregisterBySource(sourceId)` | `ctx.core.sources.unregister(sourceId)` |
| `ctx.tools.registerDefinitions(defs)` | `ctx.core.definitions.register({ sourceId, definitions })` |
| `ctx.sources.addManager({ kind, list, remove, detect, refresh })` | `plugin.removeSource`, `plugin.refreshSource`, no `detect` or `list` (those are either automatic or gone) |
| `ctx.sources.addManager({ detect })` | Gone — handle URL autodetection in a control tool if needed |
| `registerRuntimeTools([runtimeTool(...)])` | `plugin.staticSources(self) => [...]` |
| `ToolInvoker.resolveAnnotations(toolId)` | `plugin.resolveAnnotations({ ctx, sourceId, toolRows })` — note: **bulk** now |
| `ctx.secrets.resolve(secretId, scopeId)` | `ctx.secrets.get(id)` — scope is bound at executor creation, not per-call |
| `ctx.secrets.addProvider(provider)` | `plugin.secretProviders: [...]` — static, not runtime |
| `ScopedKv` with `kv.get/put/list/delete` | Declare a `schema`, implement `storage: (deps) => typedAdapter<...>(deps.adapter)`, use model-based CRUD |
| `withConfigFile` wrapping a KV | Gone — use the adapter directly. Config file snapshotting (for import/export) is a separate concern we'll revisit. |
| Old `makeKvOperationStore`, `makeKvBindingStore`, etc. | Inline the store construction in `makeDefault{Plugin}Store(adapter, blobs)` using `typedAdapter<PluginSchema>` |

### OAuth2 flows (openapi, google-discovery, mcp)

These plugins share the same shape now, all built on
`@executor/plugin-oauth2`:

1. Extension exposes `startOAuth(input)` that returns a `{ sessionId,
   authorizationUrl, scopes }` response. It stores a transient
   `OAuthSession` in a plugin-owned `oauth-sessions` table (15-min TTL).
2. Extension exposes `completeOAuth(input)` that validates the session,
   calls `exchangeAuthorizationCode` from `@executor/plugin-oauth2`,
   persists the tokens via `storeOAuthTokens`, and returns an auth
   descriptor the user passes to `addSource`.
3. `invokeTool` calls `withRefreshedAccessToken` from
   `@executor/plugin-oauth2` which resolves / refreshes / persists the
   access token and returns it, then injects
   `Authorization: ${tokenType} ${token}` into the request.
4. The `OAuth2SecretsIO` adapter that oauth2's helpers require is built
   inline by wrapping `ctx.secrets.get` and `executor.secrets.set`. See
   `plugins/openapi/src/sdk/plugin.ts` in the pre-port reference.
5. The `POST /oauth/callback` endpoint (if the plugin has an API layer)
   uses `runOAuthCallback` from `@executor/plugin-oauth2/http` to render
   the popup HTML that posts results back via `BroadcastChannel`.

Plugins with OAuth2 need `@executor/plugin-oauth2` as a workspace
dependency.

## Checklist for a complete port

- [ ] `schema` declared with `as const satisfies DBSchema`, type exported
- [ ] `storage` factory wraps `typedAdapter<Schema>(deps.adapter)` and
      returns a typed store
- [ ] All of the old plugin's extension methods are present on the new
      extension, and each has the same semantics
- [ ] Control tools (`previewSpec`, `addSource`, `connect`, etc.) are
      declared in `staticSources` with inline handlers that call `self.*`
- [ ] Dynamic tools handled via `invokeTool({ ctx, toolRow, args, elicit })`
- [ ] `resolveAnnotations` returns the same approval semantics the old
      `ToolInvoker.resolveAnnotations` returned (HTTP method → requiresApproval
      for openapi/google-discovery, etc.)
- [ ] `removeSource` / `refreshSource` lifecycle hooks cover the old source
      manager's remove/refresh semantics
- [ ] `secretProviders` covers the old `ctx.secrets.addProvider` calls
- [ ] OAuth2 flows (if applicable): `startOAuth` + `completeOAuth` +
      `withRefreshedAccessToken` at invoke time
- [ ] Tests rewritten against `makeTestConfig` + `createExecutor`. Old
      `makeInMemoryToolRegistry` / `makeInMemorySourceRegistry` /
      `makeInMemorySecretStore` / `makeInMemoryPolicyEngine` imports removed
- [ ] All old imports from `@executor/sdk` that no longer exist are gone
      (grep for `ToolRegistration`, `ToolInvoker`, `registerRuntimeTools`,
      `PluginContext`, `ExecutorPlugin`, `SecretStore`, `SourceManager`,
      `Kv`, `ScopedKv`, `makeInMemoryScopedKv`, `makeKvOperationStore`)
- [ ] `plugin-kv.ts` / `kv-operation-store.ts` / similar files DELETED,
      not left lying around
- [ ] `ctx.secrets.resolve(id, scopeId)` call sites migrated to
      `ctx.secrets.get(id)`
- [ ] `typecheck` clean
- [ ] Tests green
- [ ] No new files created that aren't part of the port (don't refactor
      adjacent concerns in the same PR)

## Where to look when stuck

- **Full working plugin** — [`src/executor.test.ts`](./src/executor.test.ts)
- **Plugin contract** — [`src/plugin.ts`](./src/plugin.ts)
- **Executor runtime** — [`src/executor.ts`](./src/executor.ts)
- **Core schema** — [`src/core-schema.ts`](./src/core-schema.ts)
- **Secret provider shape** — [`src/secrets.ts`](./src/secrets.ts)
- **Elicitation types** — [`src/elicitation.ts`](./src/elicitation.ts)

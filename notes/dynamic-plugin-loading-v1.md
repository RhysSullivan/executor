# Dynamic Plugin Loading — v1

Date: 2026-05-02

## Context

Today plugins are workspace deps statically imported in `apps/local/src/server/executor.ts`
inside `createLocalPlugins()`. They register secret providers, connection providers,
and dynamic tools through `definePlugin`. The DX of authoring one is good — the
problem is that adding a plugin means editing host source. We want users to be
able to install plugins from npm and pick them up by editing config alone.

The existing in-process plugin model already gets a lot right and we want to
keep it: Effect-native everything, end-to-end type inference from schema →
storage → extension → consumer (`executor[pluginId]`), scope-aware ctx, closure
methods, zero-allocation static tools delegating via `staticSources(self) =>
[...]`. Whatever changes here must preserve those properties.

What's missing is registration of three new surfaces from a plugin:

- **API routes** — HTTP endpoints owned by the plugin, contributed as an
  `HttpApiGroup` so they compose into the host's existing typed `HttpApi`
- **Frontend** — pages/widgets/components contributed to the host UI, with
  reactive `AtomHttpApi`-backed clients matching the existing `toolsAtom` /
  `sourcesAtom` pattern in `packages/react/src/api/atoms.tsx`
- **SDK** — already present via `extension`; the new HTTP routes give the
  frontend a typed reactive client without hand-written fetch glue

## Goal and non-goals

**v1 goals:**

- A plugin is a single npm package. `bun add @executor-js/plugin-foo`,
  add it to `executor.config.ts`, restart, and it works.
- Plugins can register: extension methods (today), API routes (new),
  frontend pages/widgets (new).
- Frontend half gets a typed reactive client from the plugin's `HttpApiGroup`
  via the same `AtomHttpApi` pattern the core uses today.
- A plugin author can write the whole thing importing only from
  `@executor-js/sdk` (and `@executor-js/sdk/client` on the frontend). Effect
  imports are optional — for authors who want them, not required for those
  who don't.
- `executor.config.ts` is the single source of truth — same file consumed by
  the schema-gen CLI and the runtime.
- Type inference end-to-end stays intact (`executor.foo.method()` autocompletes).

**Non-goals for v1:**

- Cloud / multi-tenant deployment.
- Electron desktop dynamism. Desktop builds bake plugins at build time.
- Sandboxing, capability enforcement, marketplace, signing.
- Hot reload of plugin code (restart is fine).
- Loading plugins by string spec at runtime (we use import-and-call instead;
  see decision #1).

## Reference research summary

Surveyed five plugin systems in `.reference/`:

- **pi-mono** — filesystem scanning + jiti, factory function + ExtensionAPI.
  Two-phase load (registration vs. action) is a clean idea.
- **opencode** — string specs in JSONC, dynamic `import()`, hook trigger
  pattern with `(input, output)` mutation.
- **openclaw** — manifest-first control plane (`openclaw.plugin.json` declares
  capabilities statically so the host can plan activation without loading code).
- **emdash** — **closest match to our setup.** Astro/Vite + React, plugins are
  npm packages with separate `./` and `./admin` exports, registered via
  import-and-call in `astro.config.mjs`. `definePlugin({ id, hooks, routes,
  admin })` declarative shape.
- **dynamic-software** — most ambitious; Cloudflare Worker Loader for cloud
  isolation, iframe + postMessage RPC for UI, Proxy-based typed API client.

The pattern that fits us cleanest is emdash's: import-and-call in a config
file, single npm package with separate server/client exports, host integrates
via Vite. We don't need dynamic-software's Proxy RPC client because
`@effect/platform` already gives us `HttpApiClient` plus `AtomHttpApi` for
the reactive React side — both already used heavily in
`packages/core/api/src/api.ts` and `packages/react/src/api/`.

## Decisions

### 1. Config is import-and-call, not string specs

`executor.config.ts` holds real imports of plugin factory functions. Type
inference flows naturally; no codegen step.

```ts
// apps/local/executor.config.ts (after)
import { defineExecutorConfig } from "@executor-js/sdk"
import { openApiPlugin } from "@executor-js/plugin-openapi"
import { mcpPlugin } from "@executor-js/plugin-mcp"
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets"

export default defineExecutorConfig({
  dialect: "sqlite",
  plugins: [
    openApiPlugin(),
    mcpPlugin({ dangerouslyAllowStdioMCP: true }),
    fileSecretsPlugin(),
  ] as const,
})
```

"Dynamic" means npm-installable, not load-by-string-name. Same model as emdash.
Codegen-based string specs (TanStack Router style) deferred to later if remote
config becomes a need.

### 2. Plugin = single npm package, two exports

```jsonc
// @executor-js/plugin-foo/package.json
{
  "name": "@executor-js/plugin-foo",
  "type": "module",
  "exports": {
    "./server": "./dist/server.js",
    "./client": "./dist/client.js"
  },
  "executor": {
    "id": "foo",
    "version": "0.1.0"
  }
}
```

```
@executor-js/plugin-foo/
├── package.json
├── src/
│   ├── server.ts    # Effect, Node deps, definePlugin
│   ├── client.tsx   # React, defineClientPlugin
│   └── shared.ts    # Schemas, types shared across the boundary
└── dist/
```

Strict separation: server bundle never imports React, client bundle never
imports Effect/Node modules. Shared types live in `src/shared.ts` and are
imported by both halves.

### 3. Extend `PluginSpec` with optional `routes`; add parallel `defineClientPlugin`

Server side: keep `definePlugin`. Add optional `routes` field (the
`HttpApiGroup`) and `handlers` field (the typed `Layer`). No frontend
concepts on the server side.

Client side: separate primitive `defineClientPlugin` lives in
`@executor-js/sdk/client`. Can only be imported in the `./client` entry, so
React types never leak into server bundles.

**Layering — extension is the canonical SDK; routes/handlers is optional HTTP transport.**
The HTTP layer is *not a peer* of the SDK; it's a transport over it. Plugin
authors should treat extension as the implementation and write handlers as
thin wrappers that delegate via the `self` parameter (same pattern as
`staticSources(self) => [...]` already in the codebase). This keeps:

- a single source of truth for the plugin's behavior
- in-process callers paying zero serialization cost
- HTTP callers getting auth/scope/observability middleware
- error contracts identical across the two surfaces

Three plugin shapes fall out of this layering:

- **SDK-only.** Pure programmatic. No `routes`, no `handlers`, no `./client`
  export. Examples: file-secrets, keychain, onepassword, anything that's a
  utility for other plugins or scripts. CLI/embedded consumers use
  `executor.<id>.method()`. Vite plugin notices no `./client` and skips the
  plugin in the frontend bundle entirely.
- **Both.** Extension *and* routes/handlers *and* a `./client`. Examples:
  openapi, mcp, anything that needs a frontend. Routes are thin wrappers
  over extension methods.
- **HTTP-only.** Rare — webhook receivers, OAuth callback URLs. Routes
  without a meaningful in-process equivalent. May or may not have an
  extension.

### 4. Routes are an `HttpApiGroup`; client uses `AtomHttpApi`

Plugins ship the same primitive the core uses (`HttpApiGroup` from
`effect/unstable/httpapi`). The host composes via the existing `addGroup`
helper at `packages/core/api/src/api.ts:21`. OpenAPI annotations and docs
flow automatically.

For the frontend, plugins build a per-plugin `AtomHttpApi.Service` against
their own group, wrapped behind a `createPluginAtomClient(group, opts)`
helper. The resulting atoms are consumed via the existing
`useAtomValue` / `useAtomSet` + `AsyncResult.match` idiom — same pattern
as `toolsAtom`, `sourcesAtom`, etc.

### 5. SDK re-exports the Effect HttpApi/Schema primitives

Plugin authors can write a complete plugin importing only from
`@executor-js/sdk` (server) and `@executor-js/sdk/client` (frontend). The SDK
re-exports `Schema`, `HttpApi`, `HttpApiGroup`, `HttpApiEndpoint`,
`HttpApiBuilder`, `Effect` so authors who don't want to dig into Effect
don't have to. Authors who *do* want Effect-native code keep importing from
`effect` directly. This keeps the door open without forcing the dependency.

### 6. Skip `capabilities` declaration for v1

`["read:secrets", "network:fetch"]` style declarations are useful for sandboxing
but unenforced metadata is just noise. Add when there's a real isolation story.

### 7. `executor.config.ts` is the single source of truth

Today the schema-gen CLI reads `executor.config.ts` but the runtime hardcodes
`createLocalPlugins()` in `apps/local/src/server/executor.ts:96`. Consolidate:
the runtime imports from `executor.config.ts` too. One list, two consumers.

### 8. Canary plugin: build new tiny one first, then migrate openapi

Validate the shape with a minimal `@executor-js/plugin-example` (one extension
method, one route, one widget) before changing real plugins.

### 9. Cross-plugin pluggable capabilities: per-capability typed fields

Some capabilities (secrets, eventually artifacts, maybe more) are
"pluggable" — many plugins can implement them, the host swaps between
providers via config, consumer code stays agnostic.

Don't generalize this. The existing `secretProviders` field on the spec
already handles this exact pattern for secrets and works fine:

```ts
// what plugins do today
secretProviders: (ctx) => [makeScopedProvider(...)]
```

Each new pluggable capability gets its *own* typed field on `PluginSpec`,
same shape. When artifacts lands, that's `artifactStore: () =>
ArtifactStore`. If connection providers want to be modeled this way, the
existing `connectionProviders` field already is.

No `provides` / `requires` / `service` machinery, no Effect-Tag-as-generic-
primitive abstraction, no "protocols" concept, no naming debate. The
artifacts note's "protocol" framing translates directly to "the v2
`artifactStore` field on `PluginSpec`."

If we eventually have 5–6 of these and the boilerplate genuinely screams
for generalization, we generalize then. Likely won't.

For v1 nothing changes here — `secretProviders` is what it is, and
artifacts aren't shipping yet.

## New type sketches

### `PluginSpec` extension

Existing fields unchanged. Add `routes` returning an `HttpApiGroup`:

```ts
// packages/core/sdk/src/plugin.ts (extension)
import type { HttpApiGroup } from "effect/unstable/httpapi"

export interface PluginSpec<TId, TExtension, TStore, TSchema> {
  // ... existing: id, schema, storage, extension, staticSources,
  //     invokeTool, secretProviders, etc.

  /** HttpApiGroup contributed by this plugin. Composed into the host's
   *  HttpApi via the existing `addGroup` helper (api.ts:21). Host mounts
   *  it at /_executor/plugins/{id}/... and supplies auth + scope
   *  middleware. Endpoints automatically appear in the executor OpenAPI
   *  doc and the typed client.
   *
   *  Type is `HttpApiGroup.Any` because the host composes a runtime array
   *  of groups; there's no compile-time way to track the full union. The
   *  strong typing of each group's endpoints lives inside the plugin —
   *  the plugin imports its own group directly in both `handlers` and
   *  the client (`createPluginAtomClient`), so endpoint payloads,
   *  responses, and errors are all concrete there. */
  readonly routes?: () => HttpApiGroup.Any

  /** Handlers Layer for this plugin's group. Built by the plugin against
   *  its own bundled API for full type safety on `.handle("name", ...)`,
   *  composes into the host's runtime `FullApi` because
   *  `HttpApiBuilder.group` keys the layer by group identity, not by the
   *  surrounding API.
   *
   *  Receives `self: NoInfer<TExtension>` so handlers can delegate to
   *  extension methods (`self.listThings()`) — same pattern as
   *  `staticSources`. The extension is canonical; handlers are transport. */
  readonly handlers?: (
    self: NoInfer<TExtension>,
  ) => Layer.Layer<unknown, unknown, unknown>
}
```

Example plugin shape — group definition in `shared.ts` so client and
server both import it:

```ts
// @executor-js/plugin-foo/src/shared.ts
import { HttpApiEndpoint, HttpApiGroup, Schema } from "@executor-js/sdk"

export const Thing = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})

export const FooApi = HttpApiGroup.make("foo")
  .add(
    HttpApiEndpoint.get("listThings")`/things`
      .addSuccess(Schema.Array(Thing)),
  )
  .add(
    HttpApiEndpoint.post("syncThing")`/sync/:id`
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(Thing)
      .addError(SyncError),
  )
```

```ts
// @executor-js/plugin-foo/src/server.ts
import { definePlugin, HttpApi, HttpApiBuilder } from "@executor-js/sdk"
import { FooApi } from "./shared"

// Bundle the group into a small HttpApi *for typing purposes only*. The
// handlers Layer is keyed by the FooApi group's identity, so it composes
// cleanly into the host's FullApi at runtime regardless of what other
// groups are around it.
const FooApiBundle = HttpApi.make("foo").add(FooApi)

export const fooPlugin = definePlugin((opts?: FooConfig) => ({
  id: "foo" as const,
  storage: () => ({ /* ... */ }),

  extension: (ctx) => ({
    listThings: () => /* Effect — canonical impl */,
    syncThing: (id: string) => /* Effect — canonical impl */,
  }),

  routes: () => FooApi,                       // exposes the group

  // Handlers are thin transport wrappers — they delegate to extension
  // methods via `self`. Same pattern as `staticSources(self) => [...]`.
  handlers: (self) =>
    HttpApiBuilder.group(FooApiBundle, "foo", (h) =>
      h
        .handle("listThings", () => self.listThings())
        .handle("syncThing", ({ path }) => self.syncThing(path.id)),
    ),
}))
```

Why `routes` and `handlers` are split: `routes` is the API description (a
group), `handlers` is the implementation Layer that delegates to the
extension. The host needs the group at composition time (to build
`FullApi`) and the Layer at serve time (to provide handler
implementations). Both are derived from the same `FooApi` in `shared.ts`.

### `defineClientPlugin`

Lives in `@executor-js/sdk/client`. Server bundles cannot import this module.

```ts
// packages/core/sdk/src/client.ts
export interface ClientPluginSpec<TId extends string = string> {
  readonly id: TId

  /** Pages contributed to the host's TanStack router. Mounted under
   *  /plugins/{id}/{path}. Sidebar nav metadata declared on the route. */
  readonly pages?: readonly PageDecl[]

  /** Dashboard / overview widgets the host can render in known slots. */
  readonly widgets?: readonly WidgetDecl[]

  /** Components the host can render in named slots (e.g., source-detail
   *  panels, secret-picker variants). Slot names are part of the host
   *  contract — plugin opts in by registering. */
  readonly slots?: Record<string, ComponentType<SlotProps>>
}

type PageDecl = {
  path: string                          // "/", "/edit/$id"
  component: ComponentType
  nav?: { label: string; section?: string }
}

type WidgetDecl = {
  id: string
  component: ComponentType<WidgetProps>
  size?: "half" | "full"
}

export const defineClientPlugin = <TId extends string>(
  spec: ClientPluginSpec<TId>,
) => spec
```

### `createPluginAtomClient` — typed reactive client per plugin

Plugins build their own `AtomHttpApi.Service` against their own group
bundled into a small `HttpApi`. A helper hides the boilerplate so plugin
authors write one line per atom. Same shape as the existing
`ExecutorApiClient` in `packages/react/src/api/client.tsx:11`.

```ts
// packages/core/sdk/src/client.ts (helper)
import { HttpApi } from "effect/unstable/httpapi"
import { FetchHttpClient } from "effect/unstable/http"
import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi"

export const createPluginAtomClient = <G extends HttpApiGroup.Any>(
  group: G,
  opts: { pluginId: string },
) => {
  const bundle = HttpApi.make(`plugin-${opts.pluginId}`).add(group)
  return AtomHttpApi.Service<`Plugin_${string}Client`>()(
    `Plugin_${opts.pluginId}Client`,
    {
      api: bundle,
      httpClient: FetchHttpClient.layer,
      baseUrl: `/_executor/plugins/${opts.pluginId}`,
    },
  )
}
```

Plugin author writes:

```tsx
// @executor-js/plugin-foo/src/client.tsx
import {
  defineClientPlugin,
  createPluginAtomClient,
  useAtomValue,
  useAtomSet,
  AsyncResult,
} from "@executor-js/sdk/client"
import { FooApi } from "./shared"

const FooClient = createPluginAtomClient(FooApi, { pluginId: "foo" })

export const fooThingsAtom = FooClient.query("foo", "listThings", {
  timeToLive: "30 seconds",
  reactivityKeys: ["foo:things"],
})

export const fooSync = FooClient.mutation("foo", "syncThing")

const FooPage = () => {
  const things = useAtomValue(fooThingsAtom)
  const doSync = useAtomSet(fooSync, { mode: "promise" })

  return AsyncResult.match(things, {
    onInitial: () => <Skeleton />,
    onFailure: () => <p>Failed to load</p>,
    onSuccess: ({ value }) => (
      <Table
        rows={value}
        onSync={(id) => doSync({ path: { id } })}
      />
    ),
  })
}

export default defineClientPlugin({
  id: "foo" as const,
  pages: [{ path: "/", component: FooPage, nav: { label: "Foo" } }],
  widgets: [{ id: "foo-status", component: FooStatus, size: "half" }],
})
```

Type inference: `FooClient.query("foo", "listThings", ...)` is fully typed
against `FooApi` — same checks the existing `ExecutorApiClient.query("tools",
"list", ...)` performs. No codegen, no host-wide composed-API typing
required. Each plugin is self-contained in its client typing.

Server-side composition: the host builds the runtime `FullApi` from
`routes()` results, then provides the `handlers()` layers when serving.
Each plugin's handlers Layer is keyed by its group's identity, so it
slots into `FullApi` without the host needing the typed structure:

```ts
const FullApi = config.plugins.reduce(
  (api, p) => p.routes ? api.add(p.routes()) : api,
  CoreExecutorApi,
)
const PluginHandlerLayers = Layer.mergeAll(
  ...config.plugins.flatMap((p) => p.handlers ? [p.handlers()] : []),
)
const ServerLive = HttpApiBuilder.api(FullApi).pipe(
  Layer.provide(PluginHandlerLayers),
  Layer.provide(CoreHandlerLayers),
)
```

Effect errors flow through the existing typed-error machinery — same as
core handlers in `packages/core/api/src/handlers/`.

### Loader: `executor.config.ts` → runtime + frontend bundle

Single config, two consumers.

**Backend** (replaces `createLocalPlugins`):

```ts
// apps/local/src/server/executor.ts (after)
import config from "../../executor.config.ts"

const executor = yield* createExecutor({
  scopes: [scope],
  adapter,
  blobs,
  plugins: config.plugins,
  onElicitation: "accept-all",
})
```

The plugins are already configured (factory called) by the time
`executor.config.ts` is evaluated, so no async loader needed.

**Frontend** — Vite plugin reads the same config, resolves each plugin's
`./client` export, exposes a virtual module:

```ts
// packages/vite-plugin-executor/src/index.ts (pseudocode)
export default function executorVite(): Plugin {
  return {
    name: "executor-plugins",
    resolveId(id) {
      if (id === "virtual:executor/plugins-client") return "\0" + id
    },
    async load(id) {
      if (id !== "\0virtual:executor/plugins-client") return
      const config = await loadExecutorConfig()
      const imports = config.plugins
        .map((p, i) => `import p${i} from "${p.id}/client"`)
        .join("\n")
      const list = config.plugins.map((_, i) => `p${i}`).join(", ")
      return `${imports}\nexport const plugins = [${list}]`
    },
  }
}
```

Host app consumes:

```tsx
// apps/local/src/main.tsx (pseudocode)
import { plugins } from "virtual:executor/plugins-client"
import { mountPluginRoutes, mountPluginWidgets } from "@executor-js/react"

const router = createRouter({
  routeTree: extendRouteTree(baseRouteTree, plugins),
})
```

HMR works because the virtual module is part of Vite's graph. Adding a plugin
needs a Vite restart (not a hot update — config changed).

## End-to-end example plugin

```
@executor-js/plugin-example/
├── package.json
└── src/
    ├── server.ts
    ├── client.tsx
    └── shared.ts
```

```ts
// src/shared.ts — only @executor-js/sdk imports, no raw effect imports
import { HttpApiEndpoint, HttpApiGroup, Schema } from "@executor-js/sdk"

export const Greeting = Schema.Struct({
  message: Schema.String,
  count: Schema.Number,
})
export type Greeting = typeof Greeting.Type

export const ExampleApi = HttpApiGroup.make("example")
  .add(
    HttpApiEndpoint.post("greet")`/greet`
      .setPayload(Schema.Struct({ name: Schema.String }))
      .addSuccess(Greeting),
  )
```

```ts
// src/server.ts
import { definePlugin, Effect, HttpApi, HttpApiBuilder } from "@executor-js/sdk"
import { ExampleApi } from "./shared"

const ExampleApiBundle = HttpApi.make("example").add(ExampleApi)

export const examplePlugin = definePlugin(() => ({
  id: "example" as const,
  storage: () => ({ count: 0 }),

  // Canonical implementation lives here.
  extension: (ctx) => ({
    greet: (name: string) =>
      Effect.sync(() => ({
        message: `hello ${name}`,
        count: ++ctx.storage.count,
      })),
  }),

  routes: () => ExampleApi,

  // Handler delegates to extension. payload.name is fully typed.
  handlers: (self) =>
    HttpApiBuilder.group(ExampleApiBundle, "example", (h) =>
      h.handle("greet", ({ payload }) => self.greet(payload.name)),
    ),
}))

export default examplePlugin
```

```tsx
// src/client.tsx
import {
  defineClientPlugin,
  createPluginAtomClient,
  useAtomSet,
} from "@executor-js/sdk/client"
import { useState } from "react"
import { ExampleApi } from "./shared"

const ExampleClient = createPluginAtomClient(ExampleApi, { pluginId: "example" })

const greetAtom = ExampleClient.mutation("example", "greet")

const ExamplePage = () => {
  const [name, setName] = useState("world")
  const [result, setResult] = useState<string>()
  const doGreet = useAtomSet(greetAtom, { mode: "promise" })

  return (
    <div>
      <input value={name} onChange={(e) => setName(e.target.value)} />
      <button onClick={async () => {
        const g = await doGreet({ payload: { name } })
        setResult(`${g.message} (#${g.count})`)
      }}>Greet</button>
      {result && <pre>{result}</pre>}
    </div>
  )
}

export default defineClientPlugin({
  id: "example" as const,
  pages: [{ path: "/", component: ExamplePage, nav: { label: "Example" } }],
})
```

```jsonc
// package.json
{
  "name": "@executor-js/plugin-example",
  "type": "module",
  "exports": {
    "./server": "./dist/server.js",
    "./client": "./dist/client.js"
  },
  "executor": { "id": "example", "version": "0.1.0" },
  "peerDependencies": {
    "@executor-js/sdk": "workspace:*",
    "react": "catalog:"
  }
}
```

User adds it:

```ts
// apps/local/executor.config.ts
import { examplePlugin } from "@executor-js/plugin-example/server"
plugins: [/* ... */, examplePlugin()]
```

## SDK-only plugin example

Many plugins don't need HTTP at all — utilities, providers, anything used
purely from other plugins or scripts. The plugin shape collapses to one
file with no `./client` export, no `routes`, no `handlers`.

```
@executor-js/plugin-rate-limiter/
├── package.json
└── src/
    └── server.ts
```

```jsonc
// package.json
{
  "name": "@executor-js/plugin-rate-limiter",
  "type": "module",
  "exports": { "./server": "./dist/server.js" },
  "executor": { "id": "rateLimiter", "version": "0.1.0" },
  "peerDependencies": { "@executor-js/sdk": "workspace:*" }
}
```

```ts
// src/server.ts
import { definePlugin, defineSchema, Effect, Schema } from "@executor-js/sdk"

interface RateLimiterConfig {
  defaultLimit?: number
}

class RateLimitExceeded extends Schema.TaggedError<RateLimitExceeded>()(
  "RateLimitExceeded",
  { key: Schema.String, retryAfterMs: Schema.Number },
) {}

export const rateLimiterPlugin = definePlugin(
  (opts: RateLimiterConfig = {}) => ({
    id: "rateLimiter" as const,

    schema: defineSchema({
      rate_buckets: {
        fields: {
          key: { type: "string", primary: true },
          tokens: { type: "number" },
          updated_at: { type: "number" },
        },
      },
    }),

    storage: ({ adapter }) => ({
      adapter,
      defaultLimit: opts.defaultLimit ?? 60,
    }),

    extension: (ctx) => ({
      check: (key: string, cost = 1) =>
        Effect.gen(function* () {
          const bucket = yield* readOrCreateBucket(ctx.storage, key)
          const refilled = refill(bucket, ctx.storage.defaultLimit)
          if (refilled.tokens < cost) {
            return yield* new RateLimitExceeded({
              key,
              retryAfterMs: estimateRetry(refilled),
            })
          }
          yield* writeBucket(ctx.storage, key, refilled.tokens - cost)
          return { allowed: true, remaining: refilled.tokens - cost }
        }),

      reset: (key: string) =>
        Effect.tryPromise(() =>
          ctx.storage.adapter.delete({
            model: "rate_buckets",
            where: [["key", "=", key]],
          }),
        ),
    }),
  }),
)
```

Pure programmatic consumption — works identically from CLI, tests,
embedded library use, or another plugin's `extension`:

```ts
const result = yield* executor.rateLimiter.check("user-123", 5)
//    ^? { allowed: true; remaining: number }

yield* executor.rateLimiter.check("user-123", 1000).pipe(
  Effect.catchTag("RateLimitExceeded", (err) =>
    Effect.log(`hit limit on ${err.key}, retry in ${err.retryAfterMs}ms`),
  ),
)
```

What the host does with this plugin:

- **Backend** composes it into `createExecutor`, exposes `executor.rateLimiter.*`. ✅
- **HTTP server** sees no `routes`/`handlers` — mounts nothing. ✅
- **Vite plugin** sees no `./client` export in `package.json`'s exports map — adds nothing to the frontend bundle. ✅
- **CLI** uses `executor.rateLimiter.*` directly. ✅

The plugin is invisible to anything not calling it — no HTTP surface, no
frontend bundle cost, no auth surface to review.

## Sequencing

Rough build order. Each step lands independently and the system stays working
between them.

1. **Consolidate config.** Make `apps/local/src/server/executor.ts` read from
   `executor.config.ts`. Delete `createLocalPlugins`. No new features yet —
   just verify the system runs unchanged with the new wiring.
2. **SDK re-exports.** Re-export `Schema`, `HttpApi`, `HttpApiGroup`,
   `HttpApiEndpoint`, `HttpApiBuilder`, `Effect` from `@executor-js/sdk`.
   Mirror equivalents in `@executor-js/sdk/client` (`useAtomValue`,
   `useAtomSet`, `AsyncResult`). Cheap and lets later steps import from
   the SDK only.
3. **Add `routes` to `PluginSpec`** + host-side composition via the existing
   `addGroup` helper. Mount each plugin's group under
   `/_executor/plugins/{id}/...` with shared scope/auth middleware. No
   plugin uses it yet.
4. **Build `defineClientPlugin` + `createPluginAtomClient`** in
   `@executor-js/sdk/client`. Build the Vite plugin + virtual module so the
   host bundle picks up plugin client modules. No plugin uses it yet.
5. **Build `@executor-js/plugin-example`** end-to-end. This is the proof
   that the contract works; if anything is wrong the friction shows up here.
6. **Migrate `@executor-js/plugin-openapi`** to expose an `HttpApiGroup`
   for its existing extension methods + a basic source list page on the
   frontend. Real-world test.

## Open questions / deferred

- **Pluggable artifacts.** When workflows lands, add an `artifactStore`
  field on `PluginSpec` shaped like `secretProviders` — typed, no generic
  abstraction. The artifacts note's "protocol package + provider plugin +
  feature plugin" translates to "shared interface package + provider
  plugin's `artifactStore` field + consumer plugin reading from `ctx`."
- **Codegen-based string specs.** If we ever want config from a database or
  remote URL, switch to strings + a TanStack-Router-style generated `.d.ts`.
  Not needed until multi-tenant.
- **Electron dynamism.** Currently desktop bakes plugins at build time. To let
  desktop users install plugins post-ship, would need either a runtime ESM
  story (import maps) or a "plugin pack" prebuilt-bundle model. Out of scope
  for v1.
- **Sandboxing.** Plugins run in-process with full host trust. Worth revisiting
  when we have untrusted plugins (marketplace) — likely via dynamic-software's
  Worker Loader pattern or similar.
- **Per-version plugin isolation.** Cloud-only concern.
- **Hot reload of plugin code.** Restart is fine for v1; would be nice but
  costs significant design effort.

## References

- emdash: `astro.config.mjs` import-and-call pattern, `package.json` exports
  for separate admin entry — see `.reference/emdash/demos/plugins-demo/`.
- dynamic-software: PluginManifest + capability declarations idea (deferred);
  Worker Loader for cloud isolation — see `.reference/dynamic-software/`.
- openclaw: manifest-first control plane idea (deferred but worth revisiting
  when we add capability enforcement).
- Existing executor plugin contract: `packages/core/sdk/src/plugin.ts:308`
  (`PluginSpec` interface), `packages/core/sdk/src/plugin.ts:451`
  (`definePlugin` factory).
- Existing host `HttpApi` composition + plugin-group helper:
  `packages/core/api/src/api.ts:14` (`CoreExecutorApi`),
  `packages/core/api/src/api.ts:21` (`addGroup`).
- Existing reactive client pattern to mirror per-plugin:
  `packages/react/src/api/client.tsx:11` (`AtomHttpApi.Service`),
  `packages/react/src/api/atoms.tsx` (query/mutation atom definitions),
  `packages/react/src/pages/sources.tsx:167` (`AsyncResult.match` idiom).
- Existing config consumer (CLI schema-gen):
  `apps/local/executor.config.ts`.
- Existing runtime plugin list (to be consolidated):
  `apps/local/src/server/executor.ts:96` (`createLocalPlugins`).
- Existing pluggable-capability shape:
  `packages/plugins/file-secrets/src/index.ts:204` (the `secretProviders`
  field). When artifacts ship, the new `artifactStore` field follows the
  same per-capability-typed-field pattern.
- `notes/artifacts-workflows-and-generated-ui.md` — the artifacts/workflows
  plan. Uses "protocol" terminology that we're not adopting; read its
  "ArtifactStoreProtocol" as "the typed interface that goes into the
  `artifactStore` field." See decision #9.
- Earlier plugin first-principles thinking:
  `personal-notes/plugin-system-first-principles.md`,
  `personal-notes/plugin-system-primitive-and-use-cases.md`.

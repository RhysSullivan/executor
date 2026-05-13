---
name: wrdn-effect-value-inferred-types
description: Replace duplicated object API types with types inferred from the runtime value or factory that owns the shape. Use when lint or review flags an interface/type alias that mirrors a returned object such as a plugin extension, client surface, route map, or handler table.
allowed-tools: Read Grep Glob Bash
---

You fix one pattern: a TypeScript object type manually mirrors a runtime object that already owns the shape.

Prefer value-first APIs. Build the object in a named factory, then export `type X = ReturnType<typeof makeX>`. Consumers keep importing the stable type name, but the type cannot drift from the implementation.

## Trace before changing

1. **Find the source value.** Look for an object returned from a named factory, `extension: (...) => ({ ... })`, a client object, route map, or handler table.
2. **Find the duplicate type.** A nearby `interface X` or `type X = { ... }` repeats the object methods/properties.
3. **Check whether the value is the source of truth.** If the interface is a contract with multiple implementations, keep the interface.
4. **Preserve the exported type name.** Replace its definition with `ReturnType<typeof makeX>` and update callers only if needed.
5. **Use `satisfies` only at boundaries.** Do not make the implementation satisfy a duplicate shape that could drift.

## Fix shape

```ts
const makePluginExtension = (ctx: PluginCtx<Store>) => {
  const addSource = ...
  const removeSource = ...

  return {
    addSource,
    removeSource,
  };
};

export type PluginExtension = ReturnType<typeof makePluginExtension>;
```

For factories that need options:

```ts
const makePluginExtension =
  (options: PluginOptions) =>
  (ctx: PluginCtx<Store>) => ({
    addSource: ...,
  });

export type PluginExtension = ReturnType<ReturnType<typeof makePluginExtension>>;
```

## Bad

```ts
export interface McpPluginExtension {
  readonly addSource: (config: McpSourceConfig) => Effect.Effect<AddResult, Failure>;
  readonly removeSource: (namespace: string, scope: string) => Effect.Effect<void, Failure>;
}

extension: (ctx) => {
  return {
    addSource,
    removeSource,
  } satisfies McpPluginExtension;
};
```

## Good

```ts
const makeMcpPluginExtension = (ctx: PluginCtx<McpStore>) => {
  return {
    addSource,
    removeSource,
  };
};

export type McpPluginExtension = ReturnType<typeof makeMcpPluginExtension>;

extension: makeMcpPluginExtension;
```

## What not to report

- Service/dependency interfaces with multiple implementations.
- Public config input types that are intentionally a stable authored API.
- Branded IDs, discriminated unions, or small aliases that do not mirror one object value.
- Test fakes typed against an existing exported contract.
- Schema-owned data shapes; use `wrdn-effect-schema-inferred-types` for those.

## Output requirements

When reviewing, report:

- **File and line** of the duplicate object type or `satisfies` usage.
- **Value/factory** that owns the shape.
- **Why** the manual type can drift.
- **Fix**: the exact `ReturnType` alias to introduce.

When editing, name the factory after the exported type, e.g. `makeMcpPluginExtension` for `McpPluginExtension`.

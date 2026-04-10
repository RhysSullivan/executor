# Storage Abstraction Proposal

This proposal describes a storage abstraction for Executor that follows the
same broad model as Better Auth: core defines a generic storage contract,
plugins can contribute schema, hosts compose the final schema, and storage
adapters implement that schema for a specific backend.

The goal is to make storage portable across cloud, local, and self-hosted
deployments without making plugin authors write Postgres-, SQLite-, or
Cloudflare-specific persistence code.

## Target Shape

Core owns the base schema and storage contract. Plugins optionally contribute
schema. The host composes everything into one final schema and passes it to the
selected adapter.

```ts
const plugins = [openApiPlugin(...), mcpPlugin(...)] as const;

const schema = composeExecutorSchema({
  plugins,
  auth: workosAuthProvider.schema,
});

const storage = yield* makePostgresStorage(db, { schema });

const executor = yield* createExecutor({
  scope,
  storage,
  plugins,
  auth: workosAuthProvider,
});
```

Drizzle can be how SQL adapters are implemented, but it should not be the
public abstraction.

```text
@executor/storage
@executor/storage-postgres
@executor/storage-sqlite
@executor/storage-d1
```

`@executor/storage-d1` should be a later package. D1 is SQLite-shaped, but its
Cloudflare binding, deployment, and migration model are separate enough that it
should not be treated as the same adapter as local/self-host SQLite.

## Plugin Schemas

Plugin-owned data should live on the plugin definition when that data is
important enough to query, index, migrate, show in the UI, or sync.

```ts
definePlugin({
  key: "openapi",
  storage: {
    schema: {
      openApiOperations: {
        tableName: "openapi_operations",
        primaryKey: ["scopeId", "operationId"],
        fields: {
          scopeId: { type: "string", columnName: "scope_id", required: true },
          operationId: { type: "string", columnName: "operation_id", required: true },
          sourceId: { type: "string", columnName: "source_id", required: true },
          schema: { type: "json", required: true },
        },
      },
    },
  },
  init: (ctx) => ...,
});
```

This lets plugins describe their data model once. Postgres, SQLite, and D1
adapters can then store the same logical model using their own backend-specific
tables and column types.

## Moving SQLite Away From KV

Local SQLite should move from a KV-only persistence shape to schema-backed
storage.

Today, local storage is effectively:

```text
kv(namespace, key, value)
```

Important data is serialized into JSON strings and stored by namespace. That is
simple, but the database cannot validate the shape, index meaningful fields, or
migrate the data cleanly.

The target shape is real SQLite tables generated or validated from the same
schema metadata as Postgres:

```text
sources
tools
tool_definitions
secrets
policies
openapi_operations
plugin_kv
```

That makes local SQLite and cloud Postgres share the same logical data model.
SQLite stops being only a JSON blob store and becomes a real schema-backed
database.

## Keeping Plugin KV

`pluginKv` should still exist as an escape hatch.

Not every piece of plugin state needs a table. If a value is small, opaque, and
plugin-private, `pluginKv` is fine. If we need to query it, index it, migrate it,
display it, or sync it, it should probably be schema-backed.

## Type Safety

The low-level adapter can stay Better Auth-style and metadata-driven:

```ts
storage.findMany({
  model: "tools",
  where: [{ field: "scopeId", value: scopeId }],
});
```

That layer should be strict at runtime. Unknown models, unknown fields, invalid
references, and unsupported field types should fail loudly with typed storage
errors.

Normal app and plugin code should not make raw stringly storage calls
everywhere. It should mostly use typed stores on top of the generic adapter:

```ts
const tools = makeStorageToolRegistry(storage, scopeId);
const operations = makeOpenApiOperationStore(ctx.storage, ctx.scope.id);
```

This keeps the adapter flexible enough for plugin-contributed schemas while
keeping product code typed and boring.

## Composition Rules

Schema composition should be strict:

- duplicate model names fail
- duplicate table names fail
- duplicate index names fail
- invalid references fail
- unsupported field types fail against adapter capabilities
- plugin models need `scopeId` unless explicitly marked global
- auth schemas stay owned by the chosen auth provider

## Summary

Plugins describe their data model once. Hosts compose the final schema once.
Storage adapters only implement the generic contract for their backend.

As part of that, SQLite becomes schema-backed storage instead of only a KV
persistence layer.

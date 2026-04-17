# @executor/storage-core

Storage adapter interface for the executor. Defines the shared `DBAdapter`, `DBSchema`, and query-operator types every persistence backend implements, plus helpers for typed queries and an in-memory conformance test suite.

Most callers don't depend on this directly — `@executor/sdk` re-exports the public surface. Install this when you're authoring a new storage adapter and want to conform to the contract.

## Install

```sh
bun add @executor/storage-core
# or
npm install @executor/storage-core
```

## Usage

Implement an adapter:

```ts
import { createAdapter, type DBAdapter } from "@executor/storage-core";

const myAdapter: DBAdapter = createAdapter({
  // ... your backend's query / mutation hooks
});
```

Or grab typed query helpers for an existing schema:

```ts
import { typedAdapter, type DBSchema } from "@executor/storage-core";

const schema = {
  secrets: {
    fields: {
      id: { type: "string", required: true },
      value: { type: "string", required: true },
    },
  },
} satisfies DBSchema;

const db = typedAdapter(myAdapter, schema);
```

## Conformance tests

If you're building an adapter, use the shared conformance suite to verify your backend matches the contract:

```ts
import { describeDbAdapterConformance } from "@executor/storage-core/testing";

describeDbAdapterConformance({
  makeAdapter: async () => myAdapter,
});
```

The suite runs against any `describe` from your test runner. `vitest` and `@effect/vitest` are declared as optional peer dependencies — install whichever you use.

## Status

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/RhysSullivan/executor).

## License

MIT

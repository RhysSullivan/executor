# @executor-js/storage-core

Storage adapter interface for the executor. Defines the shared `DBAdapter`, `DBSchema`, and query-operator types every persistence backend implements, plus helpers for typed queries and an in-memory conformance test suite.

Most callers don't depend on this directly — `@executor-js/sdk` re-exports the public surface. Install this when you're authoring a new storage adapter and want to conform to the contract.

## Install

```sh
bun add @executor-js/storage-core
# or
npm install @executor-js/storage-core
```

## Usage

Implement an adapter:

```ts
import {
  createAdapter,
  type CustomAdapter,
  type DBAdapter,
  type DBSchema,
} from "@executor-js/storage-core";

declare const inner: CustomAdapter; // your backend's post-transform hooks
declare const schema: DBSchema;

const myAdapter: DBAdapter = createAdapter({
  schema,
  config: {
    adapterId: "my-backend",
    supportsJSON: true,
    supportsDates: true,
  },
  adapter: inner,
});
```

Or grab typed query helpers for an existing schema — purely a type-level
view, no runtime cost:

```ts
import {
  typedAdapter,
  type DBAdapter,
  type DBSchema,
} from "@executor-js/storage-core";

const schema = {
  secrets: {
    fields: {
      id: { type: "string", required: true },
      value: { type: "string", required: true },
    },
  },
} satisfies DBSchema;

declare const myAdapter: DBAdapter;

const db = typedAdapter<typeof schema>(myAdapter);
```

## Conformance tests

If you're building an adapter, use the shared conformance suite to verify your backend matches the contract. The suite is exposed as `runAdapterConformance(name, withAdapter)` from the `/testing` subpath and registers `describe` blocks against your test runner:

```ts
import {
  conformanceSchema,
  runAdapterConformance,
  type WithAdapter,
} from "@executor-js/storage-core/testing";
import { makeMemoryAdapter } from "@executor-js/storage-core/testing/memory";

const withAdapter: WithAdapter = (fn) => {
  const adapter = makeMemoryAdapter({ schema: conformanceSchema });
  return fn(adapter);
};

runAdapterConformance("memory", withAdapter);
```

The suite runs against any `describe` from your test runner. `vitest` and `@effect/vitest` are declared as optional peer dependencies — install whichever you use.

## Status

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/RhysSullivan/executor).

## License

MIT

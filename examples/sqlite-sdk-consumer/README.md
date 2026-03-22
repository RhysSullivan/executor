# SQLite SDK Consumer Example

This example shows an embedder using `@executor/platform-sdk` with a custom SQLite-backed backend.

It keeps the backend intentionally small:

- installation state is stored in SQLite
- workspace config and workspace state are stored in SQLite
- source artifacts are stored in SQLite
- executor state is stored in SQLite
- secret material is stored in SQLite

The example backend is document-oriented rather than heavily normalized so the adapter seam stays easy to follow.

## Run

```sh
bun run --cwd examples/sqlite-sdk-consumer start
```

To keep the demo ephemeral:

```sh
DATABASE_PATH=:memory: bun run --cwd examples/sqlite-sdk-consumer start
```

## Shape

The important bit is the consumer-facing construction:

```ts
import { createExecutor } from "@executor/platform-sdk";
import { createSqliteExecutorBackend } from "@executor/sqlite-sdk-consumer-example";

const executor = await createExecutor({
  backend: createSqliteExecutorBackend({
    databasePath: "./executor.sqlite",
    workspaceName: "Acme",
  }),
});
```

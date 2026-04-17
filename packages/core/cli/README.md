# @executor/cli

Command-line tool for `@executor/sdk` projects. Generates Drizzle schema files from the plugins registered in your `executor.config.ts` so database migrations stay in sync with the executor you actually run.

## Install

```sh
bun add -d @executor/cli
# or
npm install --save-dev @executor/cli
```

The binary is installed as `executor`.

## Quick start

Create an `executor.config.ts` alongside your app code:

```ts
import { defineExecutorConfig } from "@executor/sdk";
import { mcpPlugin } from "@executor/plugin-mcp";
import { openApiPlugin } from "@executor/plugin-openapi";

export default defineExecutorConfig({
  dialect: "postgres",
  plugins: [mcpPlugin(), openApiPlugin()],
});
```

Then generate a Drizzle schema from it:

```sh
bunx executor generate --output ./src/db/executor-schema.ts
# or
npx executor generate --output ./src/db/executor-schema.ts
```

The generator walks every plugin in the config, collects their schema contributions, and emits a single Drizzle schema file ready to hand to `drizzle-kit`.

## Commands

```
executor generate [options]
  --cwd <dir>       Project directory (default: cwd)
  --config <path>   Path to executor.config.ts (default: auto-discover)
  --output <path>   Output file for the generated schema
```

Run `executor --help` to see the current command list.

## Status

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/RhysSullivan/executor).

## License

MIT

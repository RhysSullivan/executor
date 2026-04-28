# @executor/codemode-core

Core primitives for "code mode" — the pattern where an LLM writes TypeScript/JavaScript that calls into a pre-registered set of tools, executed in a sandbox. This package provides the shared type surface (`Tool`, `SandboxToolInvoker`, `CodeExecutor`), JSON Schema helpers, and error types used by every runtime that implements the contract.

Most callers depend on this transitively through `@executor/execution` and a sandbox runtime like `@executor/runtime-quickjs`. Install directly when you're authoring a new runtime.

## Install

```sh
bun add @executor/codemode-core
# or
npm install @executor/codemode-core
```

## Usage

Implement a runtime that satisfies `CodeExecutor`:

```ts
import type { CodeExecutor, SandboxToolInvoker } from "@executor/codemode-core";
import { Effect } from "effect";

export const makeMyRuntime = (): CodeExecutor => ({
  execute: (code: string, invoker: SandboxToolInvoker) =>
    Effect.gen(function* () {
      // Spin up your sandbox, expose `invoker` as `tools.<path>(...)`, run the code,
      // collect logs, and return an ExecuteResult.
    }),
});
```

The runtime is passed a `SandboxToolInvoker` that bridges sandbox-side tool calls back to the executor. The sandbox-visible API is whatever you decide — `@executor/runtime-quickjs` exposes a `tools` proxy object; a runtime targeting Cloudflare Workers might use something else.

## Status

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/RhysSullivan/executor).

## License

MIT

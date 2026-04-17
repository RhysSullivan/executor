# @executor/execution

Sandboxed JavaScript execution for an executor. Hands a `tools.<namespace>.<name>(...)` proxy into a code sandbox so an agent (or any caller) can run generated TypeScript/JavaScript that invokes the executor's registered tools.

Supports pause/resume for elicitation-driven flows: tools that need user input (OAuth, form fill, approval) suspend the sandbox, surface a `PausedExecution`, and resume on a `ResumeResponse`.

## Install

```sh
bun add @executor/sdk @executor/execution @executor/runtime-quickjs
# or
npm install @executor/sdk @executor/execution @executor/runtime-quickjs
```

`@executor/runtime-quickjs` is the sandbox runtime. It's not a dependency of `@executor/execution` — you bring your own so consumers with a different runtime don't ship ~13 MB of WASM they never use.

## Usage

```ts
import { createExecutor } from "@executor/sdk";
import { createExecutionEngine } from "@executor/execution";
import { makeQuickJsExecutor } from "@executor/runtime-quickjs";

const executor = await createExecutor({
  scope: { name: "my-app" },
});

const engine = createExecutionEngine({
  executor,
  codeExecutor: makeQuickJsExecutor({
    timeoutMs: 2_000,
    memoryLimitBytes: 32 * 1024 * 1024,
  }),
});

const result = await engine.execute(
  `
    const pets = await tools.petstore.findPetsByStatus({ status: "available" });
    return pets.length;
  `,
  {
    onElicitation: async (ctx) => {
      // A tool asked for user input mid-execution. Your UI decides what to do.
      console.log("tool needs input:", ctx.request);
      return { action: "decline" };
    },
  },
);

console.log(result);
// { result: 12, logs: [...] }
```

## Pause/resume for elicitation

When the host doesn't support inline elicitation, use `executeWithPause` to intercept the first request as a pause point:

```ts
const started = await engine.executeWithPause(code);

if (started.status === "paused") {
  const { id, elicitationContext } = started.execution;
  // Render the elicitation request in your UI. Later:
  const resumed = await engine.resume(id, {
    action: "accept",
    content: { name: "Ada" },
  });
}
```

## Workflow description for LLMs

```ts
const docs = await engine.getDescription();
// Returns the canonical "use tools.search(), then tools.describe.tool(), then call …"
// workflow prose + per-namespace tool listing. Feed this to an LLM so it knows
// how to drive the sandbox.
```

## Using with Effect

If you're building on `@executor/sdk` (the raw Effect entry), import from the `/core` subpath. The returned engine is Effect-native: `execute`, `executeWithPause`, and `resume` all become `Effect.Effect<...>`, and `onElicitation` is an `ElicitationHandler` returning `Effect.Effect<ElicitationResponse>`.

```ts
import { createExecutionEngine } from "@executor/execution";
```

## Status

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/RhysSullivan/executor).

## License

MIT

import { HttpRouter } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { AgentRpcs, RunTurnOutput, createCodeModeRunner } from "@openassistant/core";
import { Effect, Layer } from "effect";
import { runAgentLoop } from "./agent-loop.js";
import { InMemoryCalendarStore } from "./calendar-store.js";
import { createToolTree } from "./tools.js";

const port = Number(readEnv("OPENASSISTANT_GATEWAY_PORT") ?? "8787");

const calendarStore = new InMemoryCalendarStore();
const tools = createToolTree(calendarStore);
const runner = createCodeModeRunner({
  tools,
  requestApproval: () => Effect.succeed("approved"),
});

const AgentHandlersLive = AgentRpcs.toLayer(
  Effect.succeed({
    RunTurn: (input: { prompt: string; nowIso: string }) =>
      Effect.tryPromise({
        try: async () => {
          const generated = await runAgentLoop(
            input.prompt,
            (code) => Effect.runPromise(runner.run({ code })),
            {
              now: new Date(input.nowIso),
            },
          );

          return new RunTurnOutput({
            message: generated.text,
            planner: generated.planner,
            codeRuns: generated.runs.length,
            ...(isVerboseMode() ? { footer: generated.planner } : {}),
          });
        },
        catch: (error) => `RunTurn failed: ${describeUnknown(error)}`,
      }),
  }),
);

const RpcLayer = RpcServer.layer(AgentRpcs).pipe(Layer.provide(AgentHandlersLive));

const HttpProtocolLayer = RpcServer.layerProtocolHttp({
  path: "/rpc",
}).pipe(Layer.provide(RpcSerialization.layerNdjson));

const MainLayer = HttpRouter.Default.serve().pipe(
  Layer.provide(RpcLayer),
  Layer.provide(HttpProtocolLayer),
  Layer.provide(BunHttpServer.layer({ port })),
);

console.log(`[gateway] listening on http://localhost:${port}/rpc`);
BunRuntime.runMain(Layer.launch(MainLayer));

function describeUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isVerboseMode(): boolean {
  const value = readEnv("OPENASSISTANT_VERBOSE_RESPONSE")?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function readEnv(key: string): string | undefined {
  const bun = (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun;
  return bun?.env?.[key] ?? process.env[key];
}

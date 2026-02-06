import { HttpRouter } from "@effect/platform";
import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { Effect, Layer } from "effect";
import { InMemoryCalendarStore } from "./calendar-store.js";
import { AgentRpcs, ResolveApprovalOutput, type TurnResult } from "./rpc.js";
import { createToolTree } from "./tools.js";
import { TurnManager } from "./turn-manager.js";

const port = Number(readEnv("OPENASSISTANT_GATEWAY_PORT") ?? "8787");

const calendarStore = new InMemoryCalendarStore();
const tools = createToolTree(calendarStore);
const turnManager = new TurnManager(tools, isVerboseMode());

const AgentHandlersLive = AgentRpcs.toLayer(
  Effect.succeed({
    RunTurn: (input: { prompt: string; requesterId: string; channelId: string; nowIso: string }) =>
      Effect.tryPromise({
        try: async () => {
          const turnId = turnManager.start({
            prompt: input.prompt,
            requesterId: input.requesterId,
            channelId: input.channelId,
            now: new Date(input.nowIso),
          });
          const event = await turnManager.waitForNext(turnId);
          if (!event) {
            return {
              status: "failed",
              turnId,
              error: "Turn not found.",
            } as TurnResult;
          }
          return event;
        },
        catch: (error) => `RunTurn failed: ${describeUnknown(error)}`,
      }),
    ContinueTurn: (input: { turnId: string }) =>
      Effect.tryPromise({
        try: async () => {
          const event = await turnManager.waitForNext(input.turnId);
          if (!event) {
            return {
              status: "failed",
              turnId: input.turnId,
              error: "Turn not found.",
            } as TurnResult;
          }
          return event;
        },
        catch: (error) => `ContinueTurn failed: ${describeUnknown(error)}`,
      }),
    ResolveApproval: (input: { turnId: string; callId: string; actorId: string; decision: "approved" | "denied" }) =>
      Effect.succeed(
        new ResolveApprovalOutput({
          status: turnManager.resolveApproval({
            turnId: input.turnId,
            callId: input.callId,
            actorId: input.actorId,
            decision: input.decision,
          }),
        }),
      ),
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

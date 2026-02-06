import { FetchHttpClient } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { AgentRpcs, type RunTurnOutput } from "@openassistant/core";
import { Effect, Layer } from "effect";

const gatewayUrl = readEnv("OPENASSISTANT_GATEWAY_URL") ?? "http://127.0.0.1:8787/rpc";

const GatewayRpcClientLive = RpcClient.layerProtocolHttp({
  url: gatewayUrl,
}).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]));

export interface RunGatewayTurnInput {
  prompt: string;
  requesterId: string;
  channelId: string;
}

export async function runGatewayTurn(input: RunGatewayTurnInput): Promise<RunTurnOutput> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(AgentRpcs);
      return yield* client.RunTurn({
        prompt: input.prompt,
        requesterId: input.requesterId,
        channelId: input.channelId,
        nowIso: new Date().toISOString(),
      });
    }).pipe(Effect.scoped, Effect.provide(GatewayRpcClientLive)),
  );
}

function readEnv(key: string): string | undefined {
  const bun = (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun;
  return bun?.env?.[key] ?? process.env[key];
}

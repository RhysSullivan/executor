import { describe, expect, it } from "@effect/vitest";
import type { ConfigFileSink, SourceConfig } from "@executor/config";
import { createExecutor, makeTestConfig } from "@executor/sdk";
import { Effect } from "effect";

import { mcpPlugin } from "./plugin";

describe("mcpPlugin config file sink", () => {
  it.effect("updateSource mirrors remote auth changes to the config file sink", () =>
    Effect.gen(function* () {
      const upserts: SourceConfig[] = [];
      const configFile: ConfigFileSink = {
        upsertSource: (source) =>
          Effect.sync(() => {
            upserts.push(source);
          }),
        removeSource: () => Effect.void,
      };
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [mcpPlugin({ configFile })] as const,
        }),
      );

      yield* executor.mcp
        .addSource({
          transport: "remote",
          scope: "test-scope",
          name: "Sentry MCP",
          endpoint: "http://127.0.0.1:1/sentry-mcp",
          remoteTransport: "auto",
          namespace: "sentry",
          auth: { kind: "none" },
        })
        .pipe(Effect.either);
      upserts.length = 0;

      yield* executor.mcp.updateSource("sentry", "test-scope", {
        auth: { kind: "oauth2", connectionId: "mcp-oauth2-sentry" },
      });

      expect(upserts).toHaveLength(1);
      expect(upserts[0]).toMatchObject({
        kind: "mcp",
        transport: "remote",
        name: "Sentry MCP",
        endpoint: "http://127.0.0.1:1/sentry-mcp",
        namespace: "sentry",
        auth: { kind: "oauth2", connectionId: "mcp-oauth2-sentry" },
      });
    }),
  );
});

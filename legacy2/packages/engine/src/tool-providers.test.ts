import { describe, expect, it } from "@effect/vitest";
import { type Source, SourceSchema } from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

import {
  makeToolProviderRegistry,
  ToolProviderError,
  ToolProviderRegistryError,
  type ToolProvider,
} from "./tool-providers";

const decodeSource = Schema.decodeUnknownSync(SourceSchema);

const createOpenApiSource = (): Source =>
  decodeSource({
    id: "src_openapi",
    workspaceId: "ws_local",
    name: "example",
    kind: "openapi",
    endpoint: "https://example.com/openapi.json",
    status: "connected",
    enabled: true,
    configJson: "{}",
    sourceHash: null,
    lastError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

describe("makeToolProviderRegistry", () => {
  it.effect("routes discovery and invocation through provider kind", () =>
    Effect.gen(function* () {
      const openApiProvider: ToolProvider = {
        kind: "openapi",
        discoverFromSource: (source) =>
          Effect.succeed({
            sourceHash: "hash_1",
            tools: [
              {
                providerKind: "openapi",
                sourceId: source.id,
                workspaceId: source.workspaceId,
                toolId: "getHealth",
                name: "Get health",
                description: null,
                invocationMode: "http",
                availability: "remote_capable",
                providerPayload: {
                  method: "get",
                  pathTemplate: "/healthz",
                  parameters: [],
                  requestBody: null,
                },
              },
            ],
          }),
        invoke: () =>
          Effect.succeed({
            output: { ok: true },
            isError: false,
          }),
      };

      const registry = makeToolProviderRegistry([openApiProvider]);

      const source = createOpenApiSource();
      const discovery = yield* registry.discoverFromSource(source);

      expect(discovery.tools).toHaveLength(1);
      expect(discovery.tools[0]?.toolId).toBe("getHealth");

      const result = yield* registry.invoke({
        source,
        tool: discovery.tools[0]!,
        args: { verbose: true },
      });

      expect(result.isError).toBe(false);
      expect(result.output).toEqual({ ok: true });
    }),
  );

  it.effect("fails on duplicate provider registration", () =>
    Effect.gen(function* () {
      const openApiProvider: ToolProvider = {
        kind: "openapi",
        invoke: () => Effect.succeed({ output: null, isError: false }),
      };

      const registry = makeToolProviderRegistry([openApiProvider]);
      const result = yield* Effect.either(registry.register(openApiProvider));

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(ToolProviderRegistryError);
        expect(result.left.message).toContain("Provider already registered");
      }
    }),
  );

  it.effect("fails when provider cannot discover from source", () =>
    Effect.gen(function* () {
      const mcpProvider: ToolProvider = {
        kind: "mcp",
        invoke: () =>
          new ToolProviderError({
            operation: "invoke",
            providerKind: "mcp",
            message: "not implemented",
            details: null,
          }),
      };

      const registry = makeToolProviderRegistry([mcpProvider]);
      const source = createOpenApiSource();

      const result = yield* Effect.either(registry.discoverFromSource(source));

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(ToolProviderRegistryError);
        expect(result.left.message).toContain("No provider registered");
      }
    }),
  );
});

import { describe, expect, it } from "@effect/vitest";
import {
  fetchOpenApiDocument,
  makeSourceManagerService,
} from "@executor-v2/management-api";
import {
  type SourceStore,
  type ToolArtifactStore,
} from "@executor-v2/persistence-ports";
import { makeLocalInProcessRuntimeAdapter } from "@executor-v2/runtime-local-inproc";
import { SourceSchema, type Source, type ToolArtifact } from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  buildExecuteToolDescription,
  createRuntimeRunClient,
  createSourceToolRegistry,
  createStaticToolRegistry,
  invokeRuntimeToolCallResult,
  makeOpenApiToolProvider,
  makeToolProviderRegistry,
} from "./index";

const decodeSource = Schema.decodeUnknownSync(SourceSchema);

describe("engine public API", () => {
  it.effect("executes runtime code against tools via createRuntimeRunClient", () =>
    Effect.gen(function* () {
      const runClient = createRuntimeRunClient({
        runtimeAdapter: makeLocalInProcessRuntimeAdapter(),
        toolRegistry: createStaticToolRegistry({
          tools: {
            "math.add": {
              description: "Add two numbers",
              execute: (input: { a: number; b: number }) => ({
                total: input.a + input.b,
              }),
            },
          },
        }),
      });

      const result = yield* Effect.tryPromise(() =>
        runClient.execute({
          code: "const sum = await tools.math.add({ a: 2, b: 5 }); return { answer: sum.total };",
        }),
      );

      expect(result.status).toBe("completed");
      expect(result.result).toEqual({ answer: 7 });
    }),
  );

  it.effect("builds mode-specific execute descriptions from the same registry", () =>
    Effect.gen(function* () {
      const toolRegistry = createStaticToolRegistry({
        tools: {
          "github.repos.get": {
            description: "Get a repository",
            execute: () => ({ ok: true }),
          },
          "slack.messages.send": {
            description: "Send a message",
            execute: () => ({ ok: true }),
          },
        },
      });

      const sourcesOnly = yield* buildExecuteToolDescription({
        toolRegistry,
        mode: "sources_only",
      });

      const allTools = yield* buildExecuteToolDescription({
        toolRegistry,
        mode: "all_tools",
      });

      expect(sourcesOnly).toContain("Mode: sources_only");
      expect(sourcesOnly).toContain("Discovery workflow:");
      expect(sourcesOnly).toContain("Use discover/catalog for external APIs; do not use fetch.");
      expect(sourcesOnly).toContain("HTTP/OpenAPI tool calls return { status, headers, body }");
      expect(sourcesOnly).not.toContain("github.repos.get");

      expect(allTools).toContain("Mode: all_tools");
      expect(allTools).toContain("Tool paths:");
      expect(allTools).toContain("do not use fetch for external APIs");
      expect(allTools).toContain("github.repos.get");
      expect(allTools).toContain("slack.messages.send");
    }),
  );

  it.effect("routes native discovery calls through invokeRuntimeToolCallResult", () =>
    Effect.gen(function* () {
      const toolRegistry = createStaticToolRegistry({
        tools: {
          "github.repos.get": {
            description: "Get repository",
            execute: () => ({ ok: true }),
          },
          "github.repos.list": {
            description: "List repositories",
            execute: () => ({ ok: true }),
          },
        },
      });

      const result = yield* invokeRuntimeToolCallResult(toolRegistry, {
        runId: "run_index_test_1",
        callId: "call_index_test_1",
        toolPath: "discover",
        input: {
          query: "list repos",
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      const value = result.value as { bestPath: string | null; total: number };
      expect(value.bestPath).toBe("github.repos.list");
      expect(value.total).toBeGreaterThan(0);
    }),
  );

  it.live("loads Vercel OpenAPI and discovers tools via source registry", () =>
    Effect.gen(function* () {
      const openApiSpec = yield* Effect.tryPromise(() =>
        fetchOpenApiDocument("https://openapi.vercel.sh/"),
      );

      const source: Source = decodeSource({
        id: "src_vercel_index",
        workspaceId: "ws_local",
        name: "vercel",
        kind: "openapi",
        endpoint: "https://api.vercel.com",
        status: "connected",
        enabled: true,
        configJson: JSON.stringify({ baseUrl: "https://api.vercel.com" }),
        sourceHash: null,
        lastError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const sources: Array<Source> = [source];
      const sourceStore: SourceStore = {
        getById: (workspaceId, sourceId) =>
          Effect.succeed(
            Option.fromNullable(
              sources.find(
                (candidate) =>
                  candidate.workspaceId === workspaceId && candidate.id === sourceId,
              ),
            ),
          ),
        listByWorkspace: (workspaceId) =>
          Effect.succeed(
            sources.filter((candidate) => candidate.workspaceId === workspaceId),
          ),
        upsert: () => Effect.void,
        removeById: () => Effect.succeed(false),
      };

      const artifactsByKey = new Map<string, ToolArtifact>();
      const toolArtifactStore: ToolArtifactStore = {
        getBySource: (workspaceId, sourceId) =>
          Effect.succeed(
            Option.fromNullable(artifactsByKey.get(`${workspaceId}:${sourceId}`)),
          ),
        upsert: (artifact) =>
          Effect.sync(() => {
            artifactsByKey.set(`${artifact.workspaceId}:${artifact.sourceId}`, artifact);
          }),
      };

      const sourceManager = makeSourceManagerService(toolArtifactStore);
      const refreshed = yield* sourceManager.refreshOpenApiArtifact({
        source,
        openApiSpec,
      });
      expect(refreshed.artifact.toolCount).toBeGreaterThan(0);

      const toolRegistry = createSourceToolRegistry({
        workspaceId: source.workspaceId,
        sourceStore,
        toolArtifactStore,
        toolProviderRegistry: makeToolProviderRegistry([makeOpenApiToolProvider()]),
      });

      const discovered = yield* toolRegistry.discover({
        query: "vercel",
        limit: 12,
      });

      expect(discovered.bestPath).not.toBeNull();
      expect(discovered.total).toBeGreaterThan(0);
      expect(discovered.results[0]?.source).toBe("vercel");
    }),
    120_000,
  );
});

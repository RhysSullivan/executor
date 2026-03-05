import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  createInMemoryToolInteractionPolicy,
  createRuntimeToolCallService,
  createStaticToolRegistry,
  invokeRuntimeToolCallResult,
} from "./tool-registry";

describe("tool registry", () => {
  it.effect("supports callTool plus discover and catalog", () =>
    Effect.gen(function* () {
      const repoRefSchemaJson =
        '{"properties":{"id":{"type":"number"}},"type":"object"}';

      const registry = createStaticToolRegistry({
        tools: {
          search_docs: {
            description: "Search docs",
            execute: (input: { query: string }) => ({ hits: [input.query] }),
          },
          "github.repos.get": {
            description: "Get repository",
            typing: {
              inputSchemaJson:
                '{"properties":{"owner":{"type":"string"},"repo":{"type":"string"}},"title":"GetRepoInput","type":"object"}',
              outputSchemaJson:
                '{"properties":{"full_name":{"type":"string"}},"type":"object"}',
              refHintKeys: ["#/components/schemas/Repo"],
            },
            execute: (input: { owner: string; repo: string }) => ({
              full_name: `${input.owner}/${input.repo}`,
            }),
          },
        },
        refHintTable: {
          "#/components/schemas/Repo": repoRefSchemaJson,
        },
      });

      const discovered = yield* registry.discover({ query: "github", limit: 5 });
      expect(discovered.bestPath).toBe("github.repos.get");
      expect(discovered.results.some((entry) => entry.path === "github.repos.get")).toBe(
        true,
      );
      expect(discovered.perQuery).toHaveLength(1);
      expect(discovered.perQuery[0]?.text).toBe("github");
      expect(discovered.perQuery[0]?.bestPath).toBe("github.repos.get");
      expect(discovered.results[0]?.typing).toBeUndefined();
      expect(discovered.results[0]?.inputHint).toBe("GetRepoInput");
      expect(discovered.refHintTable).toBeUndefined();

      const discoveredMulti = yield* registry.discover({
        queries: [
          { text: "github repos", depth: 1 },
          { text: "search docs", depth: 2 },
        ],
        limit: 5,
      });
      expect(discoveredMulti.perQuery).toHaveLength(2);
      expect(discoveredMulti.perQuery[0]?.bestPath).toBe("github.repos.get");
      expect(discoveredMulti.perQuery[1]?.bestPath).toBe("search_docs");

      const discoveredWithSchemas = yield* registry.discover({
        query: "github",
        includeSchemas: true,
      });
      expect(discoveredWithSchemas.results[0]?.typing?.refHintKeys).toEqual([
        "#/components/schemas/Repo",
      ]);
      expect(discoveredWithSchemas.refHintTable).toEqual({
        "#/components/schemas/Repo": repoRefSchemaJson,
      });

      const compactDiscovered = yield* registry.discover({
        query: "github",
        compact: true,
        includeSchemas: true,
      });
      expect(compactDiscovered.results[0]?.description).toBeUndefined();
      expect(compactDiscovered.results[0]?.inputHint).toBeUndefined();
      expect(compactDiscovered.results[0]?.outputHint).toBeUndefined();

      const namespaces = yield* registry.catalogNamespaces({});
      expect(namespaces.namespaces.map((namespace) => namespace.namespace)).toEqual([
        "github",
        "search_docs",
      ]);

      const catalogTools = yield* registry.catalogTools({ namespace: "github" });
      expect(catalogTools.results).toHaveLength(1);
      expect(catalogTools.results[0]?.path).toBe("github.repos.get");

      const callResult = yield* registry.callTool({
        runId: "run_1",
        callId: "call_1",
        toolPath: "github.repos.get",
        input: {
          owner: "octocat",
          repo: "hello-world",
        },
      });
      expect(callResult).toEqual({
        ok: true,
        value: {
          full_name: "octocat/hello-world",
        },
      });
    }),
  );

  it.effect("maps runtime tool paths to registry methods", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];

      const registry = createStaticToolRegistry({
        tools: {
          ping: {
            execute: () => "pong",
          },
        },
      });

      const runtimeToolCallService = createRuntimeToolCallService({
        ...registry,
        callTool: (input) => {
          calls.push(input.toolPath);
          return registry.callTool(input);
        },
      });

      const discoverResult = yield* runtimeToolCallService.callTool({
        runId: "run_2",
        callId: "call_2",
        toolPath: "discover",
        input: {
          query: "ping",
        },
      });

      expect((discoverResult as { bestPath: string | null }).bestPath).toBe("ping");
      expect(calls).toEqual([]);

      const toolResult = yield* runtimeToolCallService.callTool({
        runId: "run_2",
        callId: "call_3",
        toolPath: "ping",
      });

      expect(toolResult).toBe("pong");
      expect(calls).toEqual(["ping"]);
    }),
  );

  it.effect("supports in-memory interaction callbacks for required tools", () =>
    Effect.gen(function* () {
      let executionCount = 0;

      const registry = createStaticToolRegistry({
        workspaceId: "ws_local",
        interactionPolicy: createInMemoryToolInteractionPolicy({
          decide: (input) => {
            if (input.defaultMode !== "required") {
              return { kind: "approved" };
            }

            if (input.input?.confirm === "yes") {
              return { kind: "approved" };
            }

            return {
              kind: "denied",
              error: "Confirmation required",
            };
          },
        }),
        tools: {
          "admin.delete": {
            interaction: "required",
            execute: () => {
              executionCount += 1;
              return "deleted";
            },
          },
        },
      });

      const denied = yield* registry.callTool({
        runId: "run_approve_1",
        callId: "call_approve_1",
        toolPath: "admin.delete",
        input: { confirm: "no" },
      });

      expect(denied).toEqual({
        ok: false,
        kind: "denied",
        error: "Confirmation required",
      });
      expect(executionCount).toBe(0);

      const approved = yield* registry.callTool({
        runId: "run_approve_1",
        callId: "call_approve_2",
        toolPath: "admin.delete",
        input: { confirm: "yes" },
      });

      expect(approved).toEqual({
        ok: true,
        value: "deleted",
      });
      expect(executionCount).toBe(1);
    }),
  );

  it.effect("preserves pending interaction results before runtime mapping", () =>
    Effect.gen(function* () {
      const registry = createStaticToolRegistry({
        interactionPolicy: createInMemoryToolInteractionPolicy({
          decide: () => ({
            kind: "pending",
            interactionId: "interaction_123",
          }),
        }),
        tools: {
          "admin.delete": {
            interaction: "required",
            execute: () => "deleted",
          },
        },
      });

      const pendingResult = yield* invokeRuntimeToolCallResult(registry, {
        runId: "run_pending_1",
        callId: "call_pending_1",
        toolPath: "admin.delete",
      });

      expect(pendingResult).toEqual({
        ok: false,
        kind: "pending",
        interactionId: "interaction_123",
        retryAfterMs: 1000,
        error: undefined,
      });

      const runtimeToolCallService = createRuntimeToolCallService(registry);
      expect(typeof runtimeToolCallService.callTool).toBe("function");
    }),
  );
});

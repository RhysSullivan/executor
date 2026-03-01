import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  createRuntimeToolCallService,
  createStaticToolRegistry,
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
      expect(discovered.results[0]?.typing).toBeUndefined();
      expect(discovered.results[0]?.inputHint).toBe("GetRepoInput");
      expect(discovered.refHintTable).toBeUndefined();

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
});

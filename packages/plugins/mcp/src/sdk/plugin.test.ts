import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createExecutor, makeTestConfig } from "@executor/core";

import { mcpPlugin } from "./plugin";
import { makeInMemoryBindingStore } from "./binding-store";
import {
  extractManifestFromListToolsResult,
  deriveMcpNamespace,
  joinToolPath,
} from "./manifest";

// ---------------------------------------------------------------------------
// Manifest extraction
// ---------------------------------------------------------------------------

describe("extractManifestFromListToolsResult", () => {
  it.effect("extracts tools from a valid listTools response", () =>
    Effect.sync(() => {
      const result = extractManifestFromListToolsResult({
        tools: [
          {
            name: "get_weather",
            description: "Get weather for a location",
            inputSchema: {
              type: "object",
              properties: { location: { type: "string" } },
            },
          },
          { name: "search", description: "Search the web" },
        ],
      });

      expect(result.tools).toHaveLength(2);
      expect(result.tools[0]!.toolName).toBe("get_weather");
      expect(result.tools[0]!.toolId).toBe("get_weather");
      expect(result.tools[0]!.description).toBe("Get weather for a location");
      expect(result.tools[1]!.toolName).toBe("search");
    }),
  );

  it.effect("sanitizes tool IDs", () =>
    Effect.sync(() => {
      const result = extractManifestFromListToolsResult({
        tools: [
          { name: "My Tool!!", description: null },
          { name: "My Tool!!", description: null },
        ],
      });

      expect(result.tools[0]!.toolId).toBe("my_tool");
      expect(result.tools[1]!.toolId).toBe("my_tool_2");
    }),
  );

  it.effect("handles empty tools list", () =>
    Effect.sync(() => {
      const result = extractManifestFromListToolsResult({ tools: [] });
      expect(result.tools).toHaveLength(0);
    }),
  );

  it.effect("extracts server metadata", () =>
    Effect.sync(() => {
      const result = extractManifestFromListToolsResult(
        { tools: [] },
        { serverInfo: { name: "test-server", version: "1.0.0" } },
      );
      expect(result.server?.name).toBe("test-server");
      expect(result.server?.version).toBe("1.0.0");
    }),
  );
});

// ---------------------------------------------------------------------------
// Namespace derivation
// ---------------------------------------------------------------------------

describe("deriveMcpNamespace", () => {
  it.effect("derives from name", () =>
    Effect.sync(() => {
      expect(deriveMcpNamespace({ name: "GitHub MCP" })).toBe("github_mcp");
    }),
  );

  it.effect("derives from endpoint", () =>
    Effect.sync(() => {
      expect(
        deriveMcpNamespace({ endpoint: "https://api.example.com/mcp" }),
      ).toBe("api_example_com");
    }),
  );

  it.effect("derives from command", () =>
    Effect.sync(() => {
      expect(
        deriveMcpNamespace({ command: "/usr/local/bin/my-mcp-server" }),
      ).toBe("my_mcp_server");
    }),
  );

  it.effect("falls back to 'mcp'", () =>
    Effect.sync(() => {
      expect(deriveMcpNamespace({})).toBe("mcp");
    }),
  );
});

// ---------------------------------------------------------------------------
// joinToolPath
// ---------------------------------------------------------------------------

describe("joinToolPath", () => {
  it.effect("joins namespace and toolId", () =>
    Effect.sync(() => {
      expect(joinToolPath("github", "search")).toBe("github.search");
    }),
  );

  it.effect("returns toolId when namespace is undefined", () =>
    Effect.sync(() => {
      expect(joinToolPath(undefined, "search")).toBe("search");
    }),
  );
});

// ---------------------------------------------------------------------------
// Plugin lifecycle
// ---------------------------------------------------------------------------

describe("mcpPlugin", () => {
  it.effect("creates executor with mcp plugin", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [mcpPlugin({ bindingStore: makeInMemoryBindingStore() })] as const,
        }),
      );

      expect(executor.mcp).toBeDefined();
      expect(executor.mcp.addSource).toBeTypeOf("function");
      expect(executor.mcp.removeSource).toBeTypeOf("function");
      expect(executor.mcp.refreshSource).toBeTypeOf("function");
      expect(executor.mcp.probeEndpoint).toBeTypeOf("function");
      expect(executor.mcp.startOAuth).toBeTypeOf("function");
      expect(executor.mcp.completeOAuth).toBeTypeOf("function");
    }),
  );

  it.effect("sources list is initially empty", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [mcpPlugin()] as const }),
      );
      const sources = yield* executor.sources.list();
      expect(sources).toHaveLength(0);
    }),
  );

  it.effect("tools list is initially empty", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [mcpPlugin()] as const }),
      );
      const tools = yield* executor.tools.list();
      expect(tools).toHaveLength(0);
    }),
  );
});

import { describe, expect, it } from "@effect/vitest";
import { SourceSchema, type CanonicalToolDescriptor } from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeMcpToolProvider } from "./mcp-provider";

const decodeSource = Schema.decodeUnknownSync(SourceSchema);

describe("makeMcpToolProvider", () => {
  it.effect("discovers MCP tools and produces stable unique tool ids", () =>
    Effect.gen(function* () {
      let closeCalls = 0;

      const provider = makeMcpToolProvider({
        connector: async (input) => {
          expect(input.endpoint).toBe("https://mcp.example/mcp");
          expect(input.transport).toBe("streamable-http");
          expect(input.queryParams).toEqual({
            workspace: "ws_local",
          });

          return {
            client: {
              listTools: async () => ({
                tools: [
                  { name: "Read File", description: "Reads a file" },
                  { name: "Read.File", description: "Also reads a file" },
                  { name: "List Users", description: null },
                ],
              }),
              callTool: async () => ({
                content: [{ type: "text", text: "ok" }],
                isError: false,
              }),
            },
            close: async () => {
              closeCalls += 1;
            },
          };
        },
      });

      const source = decodeSource({
        id: "src_mcp",
        workspaceId: "ws_local",
        name: "MCP Source",
        kind: "mcp",
        endpoint: "https://fallback.example/mcp",
        status: "connected",
        enabled: true,
        configJson: JSON.stringify({
          url: "https://mcp.example/mcp",
          transport: "streamable-http",
          queryParams: {
            workspace: "ws_local",
          },
        }),
        sourceHash: "hash_1",
        lastError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const discovered = yield* provider.discoverFromSource!(source);
      expect(discovered.sourceHash).toBe("hash_1");
      expect(discovered.tools.map((tool) => tool.toolId)).toEqual([
        "read_file",
        "read_file_2",
        "list_users",
      ]);
      expect(closeCalls).toBe(1);
    }),
  );

  it.effect("invokes MCP tool and propagates isError from MCP result payload", () =>
    Effect.gen(function* () {
      const provider = makeMcpToolProvider({
        connector: async () => ({
          client: {
            listTools: async () => ({ tools: [] }),
            callTool: async (input) => {
              expect(input.name).toBe("echo");
              expect(input.arguments).toEqual({
                value: "hello",
              });

              return {
                isError: true,
                content: [{ type: "text", text: "denied" }],
              };
            },
          },
          close: async () => undefined,
        }),
      });

      const source = decodeSource({
        id: "src_mcp",
        workspaceId: "ws_local",
        name: "MCP Source",
        kind: "mcp",
        endpoint: "https://mcp.example/mcp",
        status: "connected",
        enabled: true,
        configJson: "{}",
        sourceHash: null,
        lastError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const tool: CanonicalToolDescriptor = {
        providerKind: "mcp",
        sourceId: source.id,
        workspaceId: source.workspaceId,
        toolId: "echo",
        name: "Echo",
        description: null,
        invocationMode: "mcp",
        availability: "remote_capable",
        providerPayload: {
          kind: "mcp_tool",
          toolName: "echo",
        },
      };

      const result = yield* provider.invoke({
        source,
        tool,
        args: {
          value: "hello",
        },
      });

      expect(result.isError).toBe(true);
      expect(result.output).toEqual({
        isError: true,
        content: [{ type: "text", text: "denied" }],
      });
    }),
  );
});

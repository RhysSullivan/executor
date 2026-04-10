// ---------------------------------------------------------------------------
// MCP tool discovery — connect to an MCP server and list its tools
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import type { McpConnector } from "./connection";
import { McpToolDiscoveryError } from "./errors";
import { extractManifestFromListToolsResult, type McpToolManifest } from "./manifest";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Connect to an MCP server and discover all available tools.
 * Returns the parsed manifest containing server metadata and tool entries.
 */
export const discoverTools = (
  connector: McpConnector,
): Effect.Effect<McpToolManifest, McpToolDiscoveryError> =>
  Effect.gen(function* () {
    // Acquire connection
    const connection = yield* connector.pipe(
      Effect.mapError(
        (err) =>
          new McpToolDiscoveryError({
            stage: "connect",
            message: `Failed connecting to MCP server: ${err.message}`,
          }),
      ),
    );

    // List tools
    const listResult = yield* Effect.tryPromise({
      try: () => connection.client.listTools(),
      catch: (cause) =>
        new McpToolDiscoveryError({
          stage: "list_tools",
          message: `Failed listing MCP tools: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        }),
    });

    const manifest = extractManifestFromListToolsResult(listResult, {
      serverInfo: connection.client.getServerVersion?.(),
    });

    // Close the connection after discovery
    yield* Effect.promise(() => connection.close().catch(() => {}));

    return manifest;
  });

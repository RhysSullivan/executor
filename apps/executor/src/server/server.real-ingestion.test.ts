import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  createExecutorApiClient,
} from "@executor/platform-api";
import { type SourceDiscoveryKind } from "@executor/platform-sdk/schema";
import { createLocalExecutorServer } from "@executor/server";

const REAL_VERCEL_SPEC_URL = "https://openapi.vercel.sh";
const REAL_VERCEL_API_ENDPOINT = "https://api.vercel.com";
const REAL_LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const REAL_DEEPWIKI_MCP_ENDPOINT = "https://mcp.deepwiki.com/mcp";

const makeTempWorkspaceRoot = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectory({ prefix: "executor-real-ingestion-" })),
    Effect.provide(NodeFileSystem.layer),
  );

const createIsolatedLocalExecutorServer = () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeTempWorkspaceRoot();
    return yield* createLocalExecutorServer({
      port: 0,
      localDataDir: ":memory:",
      workspaceRoot,
    });
  });

const createApiClientHarness = () =>
  Effect.gen(function* () {
    const server = yield* createIsolatedLocalExecutorServer();
    const bootstrapClient = yield* createExecutorApiClient({
      baseUrl: server.baseUrl,
    });
    const installation = yield* bootstrapClient.local.installation({});
    const client = yield* createExecutorApiClient({
      baseUrl: server.baseUrl,
      accountId: installation.accountId,
    });

    return {
      installation,
      client,
    };
  });

const canonicalUrl = (value: string): string =>
  new URL(value).toString();

const expectDiscoveredKind = <T extends { detectedKind: SourceDiscoveryKind }>(
  result: T,
  expectedKind: SourceDiscoveryKind,
) => {
  expect(result.detectedKind).toBe(expectedKind);
};

describe("local-executor-server real ingestion", () => {
  it.live("discovers and ingests the real Vercel OpenAPI source through the API client", () =>
    Effect.scoped(Effect.gen(function* () {
      const { installation, client } = yield* createApiClientHarness();

      const discovered = yield* client.sources.discover({
        payload: {
          url: REAL_VERCEL_SPEC_URL,
        },
      });

      expectDiscoveredKind(discovered, "openapi");
      expect(canonicalUrl(discovered.endpoint)).toBe(canonicalUrl(REAL_VERCEL_API_ENDPOINT));
      expect(canonicalUrl(discovered.specUrl ?? "")).toBe(canonicalUrl(REAL_VERCEL_SPEC_URL));

      const connected = yield* client.sources.connect({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          kind: "openapi",
          name: "Vercel",
          namespace: "vercel",
          endpoint: REAL_VERCEL_API_ENDPOINT,
          specUrl: REAL_VERCEL_SPEC_URL,
          auth: {
            kind: "none",
          },
        },
      });

      expect(connected.kind).toBe("connected");
      if (connected.kind !== "connected") {
        throw new Error(`Expected connected result, received ${connected.kind}`);
      }

      const inspection = yield* client.sources.inspection({
        path: {
          workspaceId: installation.workspaceId,
          sourceId: connected.source.id,
        },
      });

      expect(inspection.namespace).toBe("vercel");
      expect(inspection.toolCount).toBeGreaterThan(250);

      const discoveredTools = yield* client.sources.inspectionDiscover({
        path: {
          workspaceId: installation.workspaceId,
          sourceId: connected.source.id,
        },
        payload: {
          query: "list user events",
          limit: 5,
        },
      });

      expect(discoveredTools.bestPath).toBeTruthy();
      expect(discoveredTools.total).toBeGreaterThan(0);
    })),
    15_000,
  );

  it.live("discovers and ingests the real Linear GraphQL source through the API client", () =>
    Effect.scoped(Effect.gen(function* () {
      const { installation, client } = yield* createApiClientHarness();

      const discovered = yield* client.sources.discover({
        payload: {
          url: REAL_LINEAR_GRAPHQL_ENDPOINT,
        },
      });

      expectDiscoveredKind(discovered, "graphql");
      expect(canonicalUrl(discovered.endpoint)).toBe(canonicalUrl(REAL_LINEAR_GRAPHQL_ENDPOINT));
      expect(discovered.specUrl).toBeNull();

      const connected = yield* client.sources.connect({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          kind: "graphql",
          name: "Linear",
          namespace: "linear",
          endpoint: REAL_LINEAR_GRAPHQL_ENDPOINT,
          auth: {
            kind: "none",
          },
        },
      });

      expect(connected.kind).toBe("connected");
      if (connected.kind !== "connected") {
        throw new Error(`Expected connected result, received ${connected.kind}`);
      }
      expect(connected.source.status).toBe("connected");
      expect(connected.source.namespace).toBe("linear");

      const inspection = yield* client.sources.inspection({
        path: {
          workspaceId: installation.workspaceId,
          sourceId: connected.source.id,
        },
      });

      expect(inspection.source.kind).toBe("graphql");
      expect(inspection.toolCount).toBeGreaterThan(100);
      expect(
        inspection.tools.every((tool) => tool.inputTypePreview === undefined),
      ).toBe(true);
      expect(
        inspection.tools.every((tool) => tool.outputTypePreview === undefined),
      ).toBe(true);

      const toolDetail = yield* client.sources.inspectionTool({
        path: {
          workspaceId: installation.workspaceId,
          sourceId: connected.source.id,
          toolPath: "linear.administrableTeams",
        },
      });

      expect(toolDetail.summary.path).toBe("linear.administrableTeams");
      expect(toolDetail.summary.inputTypePreview).toBeUndefined();
      expect(toolDetail.summary.outputTypePreview).toBeUndefined();
      expect(toolDetail.contract.input.typeDeclaration).toContain(
        "type LinearAdministrableTeamsCall = {",
      );
      expect(toolDetail.contract.input.schemaJson).toContain("\"$defs\"");

      const storedSource = yield* client.sources.get({
        path: {
          workspaceId: installation.workspaceId,
          sourceId: connected.source.id,
        },
      });

      expect(storedSource.kind).toBe("graphql");
      expect(storedSource.status).toBe("connected");
      expect(storedSource.endpoint).toBe(REAL_LINEAR_GRAPHQL_ENDPOINT);
    })),
    15_000,
  );

  it.live("discovers and ingests a real public MCP source through the API client", () =>
    Effect.scoped(Effect.gen(function* () {
      const { installation, client } = yield* createApiClientHarness();

      const discovered = yield* client.sources.discover({
        payload: {
          url: REAL_DEEPWIKI_MCP_ENDPOINT,
        },
      });

      expectDiscoveredKind(discovered, "mcp");
      expect(canonicalUrl(discovered.endpoint)).toBe(canonicalUrl(REAL_DEEPWIKI_MCP_ENDPOINT));

      const connected = yield* client.sources.connect({
        path: {
          workspaceId: installation.workspaceId,
        },
        payload: {
          kind: "mcp",
          name: "DeepWiki",
          namespace: "deepwiki",
          endpoint: REAL_DEEPWIKI_MCP_ENDPOINT,
        },
      });

      expect(connected.kind).toBe("connected");
      if (connected.kind !== "connected") {
        throw new Error(`Expected connected result, received ${connected.kind}`);
      }

      const inspection = yield* client.sources.inspection({
        path: {
          workspaceId: installation.workspaceId,
          sourceId: connected.source.id,
        },
      });

      expect(inspection.namespace).toBe("deepwiki");
      expect(inspection.toolCount).toBeGreaterThan(0);

      const discoveredTools = yield* client.sources.inspectionDiscover({
        path: {
          workspaceId: installation.workspaceId,
          sourceId: connected.source.id,
        },
        payload: {
          query: "repository",
          limit: 5,
        },
      });

      expect(discoveredTools.bestPath).toBeTruthy();
      expect(discoveredTools.total).toBeGreaterThan(0);
    })),
    15_000,
  );
});

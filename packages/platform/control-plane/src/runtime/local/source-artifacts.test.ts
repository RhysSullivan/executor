import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { SourceIdSchema, WorkspaceIdSchema, type Source } from "#schema";

import {
  buildLocalSourceArtifact,
  readLocalSourceArtifact,
  writeLocalSourceArtifact,
} from "./source-artifacts";
import type { ResolvedLocalWorkspaceContext } from "./config";
import { createCatalogImportMetadata } from "@executor/source-core";
import { createGraphqlCatalogFragment } from "@executor/source-graphql";
import { createOpenApiCatalogFragment } from "@executor/source-openapi";

const makeContext = (): Effect.Effect<
  ResolvedLocalWorkspaceContext,
  never,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fs.makeTempDirectory({
      directory: tmpdir(),
      prefix: "executor-artifacts-",
    }).pipe(Effect.orDie);

    return {
      cwd: workspaceRoot,
      workspaceRoot,
      workspaceName: "executor-artifacts",
      configDirectory: join(workspaceRoot, ".executor"),
      projectConfigPath: join(workspaceRoot, ".executor", "executor.jsonc"),
      homeConfigPath: join(workspaceRoot, ".executor-home.jsonc"),
      homeStateDirectory: join(workspaceRoot, ".executor-home-state"),
      artifactsDirectory: join(workspaceRoot, ".executor", "artifacts"),
      stateDirectory: join(workspaceRoot, ".executor", "state"),
    };
  });

const makeSource = (): Source => ({
  id: SourceIdSchema.make("src_test"),
  workspaceId: WorkspaceIdSchema.make("ws_test"),
  name: "Test Source",
  kind: "openapi",
  endpoint: "https://example.com/api",
  status: "connected",
  enabled: true,
  namespace: "test",
  bindingVersion: 1,
  binding: {
    specUrl: "https://example.com/openapi.json",
    defaultHeaders: null,
  },
  importAuthPolicy: "none",
  importAuth: { kind: "none" },
  auth: { kind: "none" },
  sourceHash: "hash_test",
  lastError: null,
  createdAt: 0,
  updatedAt: 0,
});

const makeArtifact = () => {
  const source = makeSource();
  const fragment = createOpenApiCatalogFragment({
    source,
    documents: [
      {
        documentKind: "openapi",
        documentKey: source.binding.specUrl,
        contentText: '{"openapi":"3.1.0"}',
        fetchedAt: 1,
      },
    ],
    operations: [],
  });

  return buildLocalSourceArtifact({
    source,
    syncResult: {
      fragment,
      importMetadata: createCatalogImportMetadata({
        source,
        adapterKey: "openapi",
      }),
      sourceHash: source.sourceHash,
    },
  });
};

const makeGraphqlArtifact = () => {
  const source: Source = {
    ...makeSource(),
    kind: "graphql",
    endpoint: "https://example.com/graphql",
    binding: {
      defaultHeaders: null,
    },
  };
  const fragment = createGraphqlCatalogFragment({
    source,
    documents: [
      {
        documentKind: "graphql_introspection",
        documentKey: source.endpoint,
        contentText: '{"__schema":{}}',
        fetchedAt: 1,
      },
    ],
    operations: [
      {
        toolId: "viewer",
        title: "Viewer",
        description: "Load the current viewer",
        effect: "read",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: { login: { type: "string" } },
        },
        providerData: {
          kind: "graphql",
          toolKind: "field",
          toolId: "viewer",
          rawToolId: "viewer",
          group: "query",
          leaf: "viewer",
          fieldName: "viewer",
          operationType: "query",
          operationName: "ViewerQuery",
          operationDocument: "query ViewerQuery { viewer { login } }",
          queryTypeName: "Query",
          mutationTypeName: null,
          subscriptionTypeName: null,
        },
      },
    ],
  });

  return buildLocalSourceArtifact({
    source,
    syncResult: {
      fragment,
      importMetadata: createCatalogImportMetadata({
        source,
        adapterKey: "graphql",
      }),
      sourceHash: source.sourceHash,
    },
  });
};

describe("local-source-artifacts", () => {
  it.effect("writes canonical uncompressed artifacts and reads them back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const context = yield* makeContext();
      const artifact = makeArtifact();
      const path = join(context.artifactsDirectory, "sources", "src_test.json");
      const rawDocumentPath = join(
        context.artifactsDirectory,
        "sources",
        "src_test",
        "documents",
        `${Object.keys(artifact.snapshot.catalog.documents)[0]}.txt`,
      );

      yield* writeLocalSourceArtifact({
        context,
        sourceId: "src_test",
        artifact,
      });

      expect(yield* fs.exists(path)).toBe(true);
      expect((yield* fs.readFileString(path, "utf8")).startsWith("{")).toBe(true);
      expect(yield* fs.exists(rawDocumentPath)).toBe(true);

      const persistedArtifact = JSON.parse(yield* fs.readFileString(path, "utf8"));
      const persistedDocument = Object.values(
        persistedArtifact.snapshot.catalog.documents,
      )[0] as {
        native?: ReadonlyArray<{ kind?: string }>;
        provenance?: unknown;
      };
      const persistedResource = Object.values(
        persistedArtifact.snapshot.catalog.resources,
      )[0] as {
        provenance?: unknown;
      };
      expect(
        persistedDocument.native?.some(
          (blob) => blob.kind === "source_document",
        ) ?? false,
      ).toBe(false);
      expect(persistedDocument.provenance).toBeUndefined();
      expect(persistedResource.provenance).toBeDefined();
      expect(
        Object.keys(persistedArtifact.snapshot.catalog.diagnostics),
      ).toHaveLength(0);

      const decoded = yield* readLocalSourceArtifact({
        context,
        sourceId: "src_test",
      });

      expect(decoded?.snapshot.import.adapterKey).toBe("openapi");
      expect(decoded?.sourceId).toBe("src_test");
      expect(
        (
          Object.values(decoded?.snapshot.catalog.documents ?? {})[0] as {
            native?: Array<{ value?: unknown }>;
          }
        )?.native?.[0]?.value,
      ).toBe('{"openapi":"3.1.0"}');
      expect(
        (
          Object.values(decoded?.snapshot.catalog.documents ?? {})[0] as {
            provenance?: unknown;
          }
        ).provenance,
      ).toBeUndefined();
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect(
    "preserves GraphQL execution metadata across a write/read round-trip",
    () =>
      Effect.gen(function* () {
        const context = yield* makeContext();
        const artifact = makeGraphqlArtifact();

        yield* writeLocalSourceArtifact({
          context,
          sourceId: artifact.sourceId,
          artifact,
        });

        const decoded = yield* readLocalSourceArtifact({
          context,
          sourceId: artifact.sourceId,
        });

        const executable = Object.values(
          decoded?.snapshot.catalog.executables ?? {},
        )[0];
        const binding = executable?.binding as
          | {
              kind?: string;
              toolKind?: string | null;
              operationName?: string | null;
              operationDocument?: string | null;
            }
          | undefined;
        expect(executable?.adapterKey).toBe("graphql");
        expect(executable?.display?.protocol).toBe("graphql");
        expect(binding?.toolKind ?? null).toBe("field");
        expect(binding?.operationName ?? null).toBe("ViewerQuery");
        expect(binding?.operationDocument ?? null).toBe(
          "query ViewerQuery { viewer { login } }",
        );
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect(
    "treats legacy protocol-shaped artifacts as missing cache entries",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const context = yield* makeContext();
        const artifact = makeGraphqlArtifact();
        const [legacyExecutableId, legacyExecutable] = Object.entries(
          artifact.snapshot.catalog.executables,
        )[0]!;
        const path = join(
          context.artifactsDirectory,
          "sources",
          `${artifact.sourceId}.json`,
        );

        const legacyArtifact = {
          ...artifact,
          version: 3,
          snapshot: {
            ...artifact.snapshot,
            catalog: {
              ...artifact.snapshot.catalog,
              executables: {
                ...artifact.snapshot.catalog.executables,
                [legacyExecutableId]: {
                  id: legacyExecutable.id,
                  protocol: "graphql",
                  capabilityId: legacyExecutable.capabilityId,
                  scopeId: legacyExecutable.scopeId,
                  operationType: "query",
                  operationName: "ViewerQuery",
                  operationDocument: "query ViewerQuery { viewer { login } }",
                  responseSetId: legacyExecutable.projection.responseSetId,
                  synthetic: legacyExecutable.synthetic,
                  provenance: legacyExecutable.provenance,
                },
              },
            },
          },
        };

        yield* fs.makeDirectory(join(context.artifactsDirectory, "sources"), {
          recursive: true,
        }).pipe(Effect.orDie);
        yield* fs.writeFileString(
          path,
          `${JSON.stringify(legacyArtifact)}\n`,
        ).pipe(Effect.orDie);

        const decoded = yield* readLocalSourceArtifact({
          context,
          sourceId: artifact.sourceId,
        });

        expect(decoded).toBeNull();
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

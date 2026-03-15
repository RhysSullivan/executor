import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  SourceIdSchema,
  WorkspaceIdSchema,
  type Source,
} from "#schema";

import {
  buildLocalSourceArtifact,
  readLocalSourceArtifact,
  removeLocalSourceArtifact,
  writeLocalSourceArtifact,
} from "./local-source-artifacts";
import type { ResolvedLocalWorkspaceContext } from "./local-config";
import { createOpenApiCatalogSnapshot } from "./source-catalog-snapshot";

const makeContext = (): ResolvedLocalWorkspaceContext => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "executor-artifacts-"));
  return {
    cwd: workspaceRoot,
    workspaceRoot,
    workspaceName: "executor-artifacts",
    configDirectory: join(workspaceRoot, ".executor"),
    projectConfigPath: join(workspaceRoot, ".executor", "executor.jsonc"),
    homeConfigPath: join(workspaceRoot, ".executor-home.jsonc"),
    artifactsDirectory: join(workspaceRoot, ".executor", "artifacts"),
    stateDirectory: join(workspaceRoot, ".executor", "state"),
  };
};

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
  const snapshot = createOpenApiCatalogSnapshot({
    source,
    documents: [{
      documentKind: "openapi",
      documentKey: source.binding.specUrl,
      contentText: '{"openapi":"3.1.0"}',
      fetchedAt: 1,
    }],
    operations: [],
  });

  return buildLocalSourceArtifact({
    source,
    syncResult: {
      snapshot,
      sourceHash: source.sourceHash,
    },
  });
};

describe("local-source-artifacts", () => {
  it.effect("writes uncompressed artifacts and reads them back", () =>
    Effect.gen(function* () {
      const context = makeContext();
      const artifact = makeArtifact();
      const path = join(context.artifactsDirectory, "sources", "src_test.json");
      const legacyPath = join(context.artifactsDirectory, "sources", "src_test.json.gz");
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

      expect(existsSync(path)).toBe(true);
      expect(existsSync(legacyPath)).toBe(false);
      expect(readFileSync(path, "utf8").startsWith("{")).toBe(true);
      expect(existsSync(rawDocumentPath)).toBe(true);

      const persistedArtifact = JSON.parse(readFileSync(path, "utf8"));
      const persistedDocument = Object.values(persistedArtifact.snapshot.catalog.documents)[0] as {
        native?: ReadonlyArray<{ kind?: string }>;
        provenance?: unknown;
      };
      expect(persistedDocument.native?.some((blob) => blob.kind === "source_document") ?? false).toBe(false);
      expect(persistedDocument.provenance).toBeUndefined();
      expect(Object.keys(persistedArtifact.snapshot.catalog.diagnostics)).toHaveLength(0);

      const decoded = yield* readLocalSourceArtifact({
        context,
        sourceId: "src_test",
      });

      expect(decoded?.snapshot.import.adapterKey).toBe("openapi");
      expect(decoded?.sourceId).toBe("src_test");
      expect((Object.values(decoded?.snapshot.catalog.documents ?? {})[0] as { native?: Array<{ value?: unknown }> })?.native?.[0]?.value).toBe('{"openapi":"3.1.0"}');
      expect((Object.values(decoded?.snapshot.catalog.documents ?? {})[0] as { provenance?: unknown }).provenance).toBeUndefined();
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.effect("reads legacy gz artifacts and removes both formats", () =>
    Effect.gen(function* () {
      const context = makeContext();
      const artifact = makeArtifact();
      const directory = join(context.artifactsDirectory, "sources");
      const legacyPath = join(directory, "src_test.json.gz");

      mkdirSync(directory, { recursive: true });
      writeFileSync(legacyPath, gzipSync(JSON.stringify(artifact)));

      const decoded = yield* readLocalSourceArtifact({
        context,
        sourceId: "src_test",
      });
      expect(decoded?.catalogId).toBe(artifact.catalogId);

      yield* removeLocalSourceArtifact({
        context,
        sourceId: "src_test",
      });

      expect(existsSync(join(directory, "src_test.json"))).toBe(false);
      expect(existsSync(legacyPath)).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );
});

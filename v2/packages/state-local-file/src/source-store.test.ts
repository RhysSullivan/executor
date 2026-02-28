import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as BunContext from "@effect/platform-bun/BunContext";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import {
  type Source,
  SourceIdSchema,
  SourceSchema,
  WorkspaceIdSchema,
} from "@executor-v2/schema";

import { makeLocalSourceStore } from "./source-store";

const decodeSource = Schema.decodeUnknownSync(SourceSchema);
const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceIdSchema);
const decodeSourceId = Schema.decodeUnknownSync(SourceIdSchema);

const wsLocal = decodeWorkspaceId("ws_local");
const wsRemote = decodeWorkspaceId("ws_remote");
const srcLocal = decodeSourceId("src_local");

describe("makeLocalSourceStore", () => {
  it.effect("returns empty values when source file does not exist", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const tempDir = yield* fileSystem.makeTempDirectory({
        prefix: "executor-v2-source-store-empty-",
      });

      const sourceStore = yield* makeLocalSourceStore({ rootDir: tempDir });
      const listed = yield* sourceStore.listByWorkspace(wsLocal);
      expect(listed).toHaveLength(0);

      const fetched = yield* sourceStore.getById(wsLocal, srcLocal);
      expect(Option.isNone(fetched)).toBe(true);
    }).pipe(Effect.provide(BunContext.layer)),
  );

  it.effect("upserts, lists, and removes sources by workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectory({
        prefix: "executor-v2-source-store-roundtrip-",
      });

      const sourceStore = yield* makeLocalSourceStore({ rootDir: tempDir });

      const now = Date.now();
      const localSource: Source = decodeSource({
        id: "src_local",
        workspaceId: "ws_local",
        name: "Local API",
        kind: "openapi",
        endpoint: "https://openapi.vercel.sh",
        status: "connected",
        enabled: true,
        configJson: "{}",
        sourceHash: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      });
      const otherWorkspaceSource: Source = decodeSource({
        id: "src_remote",
        workspaceId: "ws_remote",
        name: "Remote API",
        kind: "mcp",
        endpoint: "https://example.com/mcp",
        status: "draft",
        enabled: false,
        configJson: "{}",
        sourceHash: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      });

      yield* sourceStore.upsert(localSource);
      yield* sourceStore.upsert(otherWorkspaceSource);

      const listedLocal = yield* sourceStore.listByWorkspace(wsLocal);
      expect(listedLocal).toHaveLength(1);
      expect(listedLocal[0]?.id).toBe("src_local");

      const listedRemote = yield* sourceStore.listByWorkspace(wsRemote);
      expect(listedRemote).toHaveLength(1);
      expect(listedRemote[0]?.id).toBe("src_remote");

      const fetched = yield* sourceStore.getById(wsLocal, srcLocal);
      expect(Option.isSome(fetched)).toBe(true);
      if (Option.isSome(fetched)) {
        expect(fetched.value.name).toBe("Local API");
      }

      const removed = yield* sourceStore.removeById(wsLocal, srcLocal);
      expect(removed).toBe(true);

      const listedAfterRemove = yield* sourceStore.listByWorkspace(wsLocal);
      expect(listedAfterRemove).toHaveLength(0);

      const removedAgain = yield* sourceStore.removeById(wsLocal, srcLocal);
      expect(removedAgain).toBe(false);

      const sourcesPath = path.resolve(tempDir, "sources.json");
      expect(yield* fileSystem.exists(sourcesPath)).toBe(true);
    }).pipe(Effect.provide(BunContext.layer)),
  );

  it.effect("upsert replaces an existing source by workspace/source key", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const tempDir = yield* fileSystem.makeTempDirectory({
        prefix: "executor-v2-source-store-upsert-",
      });

      const sourceStore = yield* makeLocalSourceStore({ rootDir: tempDir });

      const now = Date.now();
      const first: Source = decodeSource({
        id: "src_local",
        workspaceId: "ws_local",
        name: "Local API",
        kind: "openapi",
        endpoint: "https://openapi.vercel.sh",
        status: "draft",
        enabled: true,
        configJson: "{}",
        sourceHash: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      });
      const second: Source = decodeSource({
        id: "src_local",
        workspaceId: "ws_local",
        name: "Local API Updated",
        kind: "openapi",
        endpoint: "https://openapi.vercel.sh",
        status: "connected",
        enabled: false,
        configJson: '{"team":"acme"}',
        sourceHash: "hash_1",
        lastError: null,
        createdAt: now,
        updatedAt: now + 1,
      });

      yield* sourceStore.upsert(first);
      yield* sourceStore.upsert(second);

      const listed = yield* sourceStore.listByWorkspace(wsLocal);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.name).toBe("Local API Updated");
      expect(listed[0]?.enabled).toBe(false);
      expect(listed[0]?.sourceHash).toBe("hash_1");
    }).pipe(Effect.provide(BunContext.layer)),
  );
});

import { describe, expect, it } from "@effect/vitest";
import type {
  LocalStateSnapshot,
  LocalStateStore,
} from "@executor-v2/persistence-local";
import type { StorageInstance, WorkspaceId } from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { createPmStorageService } from "./storage-service";

const createTestSnapshot = (): LocalStateSnapshot =>
  ({
    schemaVersion: 1,
    generatedAt: Date.now(),
    profile: {
      id: "profile_local",
      defaultWorkspaceId: "ws_local",
      displayName: "Local",
      runtimeMode: "local",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    organizations: [],
    organizationMemberships: [],
    workspaces: [
      {
        id: "ws_local",
        organizationId: "org_local",
        name: "Local Workspace",
        createdByAccountId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    sources: [],
    toolArtifacts: [],
    credentialBindings: [],
    oauthTokens: [],
    policies: [],
    approvals: [],
    taskRuns: [],
    storageInstances: [],
    syncStates: [],
  }) as unknown as LocalStateSnapshot;

describe("PM storage service", () => {
  it.effect("opens, inspects, queries, and removes storage instances", () =>
    Effect.gen(function* () {
      const stateRootDir = yield* Effect.promise(() =>
        mkdtemp(path.join(tmpdir(), "executor-v2-pm-storage-")),
      );

      let snapshot: LocalStateSnapshot = createTestSnapshot();

      const localStateStore: LocalStateStore = {
        getSnapshot: () => Effect.succeed(Option.some(snapshot)),
        writeSnapshot: (nextSnapshot) =>
          Effect.sync(() => {
            snapshot = nextSnapshot;
          }),
        readEvents: () => Effect.succeed([]),
        appendEvents: () => Effect.void,
      };

      const service = createPmStorageService(localStateStore, {
        stateRootDir,
      });

      const workspaceId = "ws_local" as WorkspaceId;

      const storageInstance = yield* service.openStorageInstance({
        workspaceId,
        payload: {
          scopeType: "workspace",
          durability: "ephemeral",
          ttlHours: 24,
        },
      });

      expect(storageInstance.status).toBe("active");

      const listed = yield* service.listStorageInstances(workspaceId);
      expect(listed).toHaveLength(1);

      const directoryBeforeWrite = yield* service.listStorageDirectory({
        workspaceId,
        storageInstanceId: storageInstance.id,
        payload: {
          path: "/",
        },
      });
      expect(directoryBeforeWrite.entries).toHaveLength(0);

      const storageFsPath = path.resolve(
        stateRootDir,
        "storage",
        storageInstance.id,
        "fs",
        "hello.txt",
      );

      yield* Effect.promise(() =>
        writeFile(storageFsPath, "hello from storage", "utf8"),
      );

      const directoryAfterWrite = yield* service.listStorageDirectory({
        workspaceId,
        storageInstanceId: storageInstance.id,
        payload: {
          path: "/",
        },
      });
      expect(directoryAfterWrite.entries.some((entry) => entry.name === "hello.txt")).toBe(
        true,
      );

      const filePreview = yield* service.readStorageFile({
        workspaceId,
        storageInstanceId: storageInstance.id,
        payload: {
          path: "/hello.txt",
          encoding: "utf8",
        },
      });
      expect(filePreview.content).toBe("hello from storage");

      const kvResult = yield* service.listStorageKv({
        workspaceId,
        storageInstanceId: storageInstance.id,
        payload: {
          prefix: "",
          limit: 20,
        },
      });
      expect(kvResult.items).toHaveLength(0);

      const closedStorage = yield* service.closeStorageInstance({
        workspaceId,
        storageInstanceId: storageInstance.id,
      });
      expect(closedStorage.status).toBe("closed");

      const removed = yield* service.removeStorageInstance({
        workspaceId,
        storageInstanceId: storageInstance.id,
      });
      expect(removed.removed).toBe(true);

      const listedAfterRemove = yield* service.listStorageInstances(workspaceId);
      expect(listedAfterRemove).toHaveLength(0);

      yield* Effect.promise(() =>
        rm(stateRootDir, { recursive: true, force: true }),
      );
    }),
  );
});

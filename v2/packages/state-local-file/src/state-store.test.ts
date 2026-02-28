import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as BunContext from "@effect/platform-bun/BunContext";
import { describe, expect, it } from "@effect/vitest";
import { Either, Effect, Option, Schema } from "effect";

import { type EventEnvelope, EventEnvelopeSchema } from "@executor-v2/schema";

import {
  type LocalStateSnapshot,
  LocalStateSnapshotSchema,
} from "./local-state-snapshot";
import { makeLocalStateStore } from "./state-store";

const decodeSnapshot = Schema.decodeUnknownSync(LocalStateSnapshotSchema);
const decodeEvent = Schema.decodeUnknownSync(EventEnvelopeSchema);

describe("makeLocalStateStore", () => {
  it.effect("returns empty state when snapshot and event files do not exist", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const tempDir = yield* fileSystem.makeTempDirectory({
        prefix: "executor-v2-state-store-empty-",
      });

      const stateStore = yield* makeLocalStateStore({ rootDir: tempDir });

      const snapshot = yield* stateStore.getSnapshot();
      expect(Option.isNone(snapshot)).toBe(true);

      const events = yield* stateStore.readEvents();
      expect(events).toHaveLength(0);
    }).pipe(Effect.provide(BunContext.layer)),
  );

  it.effect("writes snapshot and appends events", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fileSystem.makeTempDirectory({
        prefix: "executor-v2-state-store-roundtrip-",
      });

      const stateStore = yield* makeLocalStateStore({ rootDir: tempDir });

      const now = Date.now();
      const snapshot: LocalStateSnapshot = decodeSnapshot({
        schemaVersion: 1,
        generatedAt: now,
        profile: {
          id: "prof_local",
          defaultWorkspaceId: "ws_local",
          displayName: "Local Profile",
          runtimeMode: "local",
          createdAt: now,
          updatedAt: now,
        },
        workspaces: [
          {
            id: "ws_local",
            profileId: "prof_local",
            name: "Local Workspace",
            createdAt: now,
            updatedAt: now,
          },
        ],
        sources: [],
        toolArtifacts: [],
        credentials: [],
        oauthTokens: [],
        policies: [],
        approvals: [],
        taskRuns: [],
        syncStates: [],
      });

      const firstEvent: EventEnvelope = decodeEvent({
        id: "evt_1",
        workspaceId: "ws_local",
        sequence: 1,
        schemaVersion: 1,
        eventType: "source.added",
        payloadJson: '{"sourceId":"src_1"}',
        createdAt: now,
      });
      const secondEvent: EventEnvelope = decodeEvent({
        id: "evt_2",
        workspaceId: "ws_local",
        sequence: 2,
        schemaVersion: 1,
        eventType: "source.connected",
        payloadJson: '{"sourceId":"src_1"}',
        createdAt: now + 1,
      });

      yield* stateStore.writeSnapshot(snapshot);
      yield* stateStore.appendEvents([firstEvent]);
      yield* stateStore.appendEvents([secondEvent]);

      const persistedSnapshot = yield* stateStore.getSnapshot();
      expect(Option.isSome(persistedSnapshot)).toBe(true);
      if (Option.isSome(persistedSnapshot)) {
        expect(persistedSnapshot.value.profile.displayName).toBe("Local Profile");
      }

      const persistedEvents = yield* stateStore.readEvents();
      expect(persistedEvents).toHaveLength(2);
      expect(persistedEvents[0]?.id).toBe("evt_1");
      expect(persistedEvents[1]?.id).toBe("evt_2");

      const snapshotPath = path.resolve(tempDir, "snapshot.json");
      const eventsPath = path.resolve(tempDir, "events.jsonl");

      expect(yield* fileSystem.exists(snapshotPath)).toBe(true);
      expect(yield* fileSystem.exists(eventsPath)).toBe(true);
    }).pipe(Effect.provide(BunContext.layer)),
  );

  it.effect("rejects duplicate event ids and duplicate workspace sequence pairs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const tempDir = yield* fileSystem.makeTempDirectory({
        prefix: "executor-v2-state-store-duplicates-",
      });

      const stateStore = yield* makeLocalStateStore({ rootDir: tempDir });

      const baseEvent: EventEnvelope = decodeEvent({
        id: "evt_1",
        workspaceId: "ws_local",
        sequence: 1,
        schemaVersion: 1,
        eventType: "source.added",
        payloadJson: '{"sourceId":"src_1"}',
        createdAt: Date.now(),
      });

      const duplicateIdEvent: EventEnvelope = decodeEvent({
        id: "evt_1",
        workspaceId: "ws_local",
        sequence: 2,
        schemaVersion: 1,
        eventType: "source.updated",
        payloadJson: '{"sourceId":"src_1"}',
        createdAt: Date.now() + 1,
      });

      const duplicateSequenceEvent: EventEnvelope = decodeEvent({
        id: "evt_2",
        workspaceId: "ws_local",
        sequence: 1,
        schemaVersion: 1,
        eventType: "source.updated",
        payloadJson: '{"sourceId":"src_1"}',
        createdAt: Date.now() + 2,
      });

      yield* stateStore.appendEvents([baseEvent]);

      const duplicateIdResult = yield* Effect.either(
        stateStore.appendEvents([duplicateIdEvent]),
      );
      expect(Either.isLeft(duplicateIdResult)).toBe(true);
      if (Either.isLeft(duplicateIdResult)) {
        expect(duplicateIdResult.left._tag).toBe("LocalStateStoreError");
        expect(duplicateIdResult.left.operation).toBe("validate_events");
      }

      const duplicateSequenceResult = yield* Effect.either(
        stateStore.appendEvents([duplicateSequenceEvent]),
      );
      expect(Either.isLeft(duplicateSequenceResult)).toBe(true);
      if (Either.isLeft(duplicateSequenceResult)) {
        expect(duplicateSequenceResult.left._tag).toBe("LocalStateStoreError");
        expect(duplicateSequenceResult.left.operation).toBe("validate_events");
      }
    }).pipe(Effect.provide(BunContext.layer)),
  );
});

import type { EventEnvelope } from "@executor-v2/schema";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { LocalStateSnapshot } from "./local-state-snapshot";

export class LocalStateStoreError extends Data.TaggedError("LocalStateStoreError")<{
  operation: string;
  filePath: string;
  message: string;
  reason: string | null;
  details: string | null;
}> {}

export interface LocalStateStore {
  getSnapshot(): Effect.Effect<Option.Option<LocalStateSnapshot>, LocalStateStoreError>;
  writeSnapshot(snapshot: LocalStateSnapshot): Effect.Effect<void, LocalStateStoreError>;
  readEvents(): Effect.Effect<ReadonlyArray<EventEnvelope>, LocalStateStoreError>;
  appendEvents(events: ReadonlyArray<EventEnvelope>): Effect.Effect<void, LocalStateStoreError>;
}

export class LocalStateStoreService extends Context.Tag(
  "@executor-v2/persistence-local/LocalStateStoreService",
)<LocalStateStoreService, LocalStateStore>() {}

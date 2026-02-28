import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import {
  LocalStateStoreError,
  LocalStateStoreService,
  type LocalStateStore,
} from "./local-state-store";
import { EventEnvelopeSchema, type EventEnvelope } from "@executor-v2/schema";
import {
  LocalStateSnapshotSchema,
  type LocalStateSnapshot,
} from "./local-state-snapshot";
import * as Effect from "effect/Effect";
import { pipe } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import * as STM from "effect/STM";
import * as TSemaphore from "effect/TSemaphore";

import {
  type PersistenceErrorData,
  toInvalidDataError,
  toSchemaPersistenceError,
  withNotFoundFallback,
  withPlatformPersistenceError,
} from "./persistence-error";

const SnapshotFromJsonSchema = Schema.parseJson(LocalStateSnapshotSchema);
const decodeSnapshotFromJson = Schema.decodeUnknown(SnapshotFromJsonSchema);
const encodeSnapshotToJson = Schema.encode(SnapshotFromJsonSchema);

const EventEnvelopeFromJsonSchema = Schema.parseJson(EventEnvelopeSchema);
const decodeEventFromJson = Schema.decodeUnknown(EventEnvelopeFromJsonSchema);
const encodeEventToJson = Schema.encode(EventEnvelopeFromJsonSchema);

export type LocalStateStoreOptions = {
  rootDir: string;
  snapshotFileName?: string;
  eventLogFileName?: string;
};

const defaultSnapshotFilePath = (
  path: Path.Path,
  options: LocalStateStoreOptions,
): string => path.resolve(options.rootDir, options.snapshotFileName ?? "snapshot.json");

const defaultEventLogFilePath = (
  path: Path.Path,
  options: LocalStateStoreOptions,
): string => path.resolve(options.rootDir, options.eventLogFileName ?? "events.jsonl");

const makeLocalStateStoreError = (
  data: PersistenceErrorData,
): LocalStateStoreError => new LocalStateStoreError(data);

const mapPlatformLocalStateStoreError = withPlatformPersistenceError(
  makeLocalStateStoreError,
);

const toSchemaLocalStateStoreError = (
  operation: string,
  filePath: string,
  cause: ParseResult.ParseError,
  details?: string,
): LocalStateStoreError =>
  toSchemaPersistenceError(
    makeLocalStateStoreError,
    operation,
    filePath,
    "Invalid persisted state payload",
    cause,
    details,
  );

const toValidationLocalStateStoreError = (
  operation: string,
  filePath: string,
  details: string,
): LocalStateStoreError =>
  toInvalidDataError(
    makeLocalStateStoreError,
    operation,
    filePath,
    "Invalid event log",
    details,
  );

const writeAtomicFile = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  filePath: string,
  payload: string,
): Effect.Effect<void, LocalStateStoreError> => {
  const directoryPath = path.dirname(filePath);

  return pipe(
    fileSystem.makeDirectory(directoryPath, { recursive: true }),
    mapPlatformLocalStateStoreError("mkdir", directoryPath),
    Effect.flatMap(() =>
      pipe(
        fileSystem.makeTempFile({
          directory: directoryPath,
          prefix: `${path.basename(filePath)}.tmp-`,
        }),
        mapPlatformLocalStateStoreError("makeTempFile", directoryPath),
        Effect.flatMap((tempPath) =>
          pipe(
            fileSystem.writeFileString(tempPath, payload),
            mapPlatformLocalStateStoreError("write", tempPath),
            Effect.flatMap(() =>
              pipe(
                fileSystem.rename(tempPath, filePath),
                mapPlatformLocalStateStoreError("rename", filePath),
              ),
            ),
          ),
        ),
      ),
    ),
  );
};

const validateEventLog = (
  eventLogFilePath: string,
  events: ReadonlyArray<EventEnvelope>,
): Effect.Effect<void, LocalStateStoreError> =>
  Effect.gen(function* () {
    const seenEventIds = new Set<string>();
    const seenWorkspaceSequences = new Set<string>();

    for (const event of events) {
      if (seenEventIds.has(event.id)) {
        return yield* toValidationLocalStateStoreError(
          "validate_events",
          eventLogFilePath,
          `Duplicate event id detected: ${event.id}`,
        );
      }
      seenEventIds.add(event.id);

      const workspaceSequenceKey = `${event.workspaceId}:${event.sequence}`;
      if (seenWorkspaceSequences.has(workspaceSequenceKey)) {
        return yield* toValidationLocalStateStoreError(
          "validate_events",
          eventLogFilePath,
          `Duplicate sequence for workspace detected: ${workspaceSequenceKey}`,
        );
      }
      seenWorkspaceSequences.add(workspaceSequenceKey);
    }
  });

const readSnapshot = (
  fileSystem: FileSystem.FileSystem,
  snapshotFilePath: string,
): Effect.Effect<Option.Option<LocalStateSnapshot>, LocalStateStoreError> =>
  pipe(
    fileSystem.readFileString(snapshotFilePath),
    withNotFoundFallback(""),
    mapPlatformLocalStateStoreError("read_snapshot", snapshotFilePath),
    Effect.flatMap((rawJson) => {
      const trimmed = rawJson.trim();
      if (trimmed.length === 0) {
        return Effect.succeed(Option.none<LocalStateSnapshot>());
      }

      return pipe(
        decodeSnapshotFromJson(trimmed),
        Effect.map(Option.some),
        Effect.mapError((cause) =>
          toSchemaLocalStateStoreError("decode_snapshot", snapshotFilePath, cause),
        ),
      );
    }),
  );

const writeSnapshot = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  snapshotFilePath: string,
  snapshot: LocalStateSnapshot,
): Effect.Effect<void, LocalStateStoreError> =>
  pipe(
    encodeSnapshotToJson(snapshot),
    Effect.mapError((cause) =>
      toSchemaLocalStateStoreError("encode_snapshot", snapshotFilePath, cause),
    ),
    Effect.flatMap((snapshotJson) =>
      writeAtomicFile(fileSystem, path, snapshotFilePath, snapshotJson),
    ),
  );

const readEventLog = (
  fileSystem: FileSystem.FileSystem,
  eventLogFilePath: string,
): Effect.Effect<Array<EventEnvelope>, LocalStateStoreError> =>
  Effect.gen(function* () {
    const rawContent = yield* pipe(
      fileSystem.readFileString(eventLogFilePath),
      withNotFoundFallback(""),
      mapPlatformLocalStateStoreError("read_events", eventLogFilePath),
    );

    const lines = rawContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) {
      return [];
    }

    const events: Array<EventEnvelope> = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const event = yield* pipe(
        decodeEventFromJson(line),
        Effect.mapError((cause) =>
          toSchemaLocalStateStoreError(
            "decode_event",
            eventLogFilePath,
            cause,
            `line ${index + 1}`,
          ),
        ),
      );
      events.push(event);
    }

    yield* validateEventLog(eventLogFilePath, events);

    return events;
  });

const writeEventLog = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  eventLogFilePath: string,
  events: ReadonlyArray<EventEnvelope>,
): Effect.Effect<void, LocalStateStoreError> =>
  Effect.gen(function* () {
    const encodedLines: Array<string> = [];

    for (let index = 0; index < events.length; index += 1) {
      const encodedLine = yield* pipe(
        encodeEventToJson(events[index]),
        Effect.mapError((cause) =>
          toSchemaLocalStateStoreError(
            "encode_event",
            eventLogFilePath,
            cause,
            `event index ${index}`,
          ),
        ),
      );
      encodedLines.push(encodedLine);
    }

    const payload = encodedLines.length === 0 ? "" : `${encodedLines.join("\n")}\n`;

    yield* writeAtomicFile(fileSystem, path, eventLogFilePath, payload);
  });

export const makeLocalStateStore = (
  options: LocalStateStoreOptions,
): Effect.Effect<LocalStateStore, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const writeSemaphore = yield* STM.commit(TSemaphore.make(1));
    const snapshotFilePath = defaultSnapshotFilePath(path, options);
    const eventLogFilePath = defaultEventLogFilePath(path, options);

    return {
      getSnapshot: () => readSnapshot(fileSystem, snapshotFilePath),

      writeSnapshot: (snapshot) =>
        pipe(
          writeSnapshot(fileSystem, path, snapshotFilePath, snapshot),
          TSemaphore.withPermit(writeSemaphore),
        ),

      readEvents: () => readEventLog(fileSystem, eventLogFilePath),

      appendEvents: (events) =>
        pipe(
          readEventLog(fileSystem, eventLogFilePath),
          Effect.flatMap((existingEvents) => {
            const nextEvents = [...existingEvents, ...events];
            return pipe(
              validateEventLog(eventLogFilePath, nextEvents),
              Effect.flatMap(() =>
                writeEventLog(fileSystem, path, eventLogFilePath, nextEvents),
              ),
            );
          }),
          TSemaphore.withPermit(writeSemaphore),
        ),
    };
  });

export const LocalStateStoreLive = (
  options: LocalStateStoreOptions,
): Layer.Layer<LocalStateStoreService, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(LocalStateStoreService, makeLocalStateStore(options));

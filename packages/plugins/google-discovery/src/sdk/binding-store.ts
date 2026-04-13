import { Effect, Schema } from "effect";
import { makeInMemoryScopedKv, scopeKv, type Kv, type ScopedKv, type ToolId } from "@executor/sdk";

import {
  GoogleDiscoveryMethodBinding,
  GoogleDiscoveryOAuthSession,
  GoogleDiscoveryStoredSourceData,
} from "./types";

// ---------------------------------------------------------------------------
// OAuth session TTL — pending sessions are cleaned up after this many ms
// ---------------------------------------------------------------------------

export const GOOGLE_DISCOVERY_OAUTH_SESSION_TTL_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Stored OAuth session — session payload + expiry, serialized via Schema
// ---------------------------------------------------------------------------

const StoredOAuthSession = Schema.Struct({
  session: GoogleDiscoveryOAuthSession,
  expiresAt: Schema.Number,
});

const encodeOAuthSession = Schema.encodeSync(Schema.parseJson(StoredOAuthSession));
const decodeOAuthSession = Schema.decodeUnknownSync(Schema.parseJson(StoredOAuthSession));

const StoredBindingEntry = Schema.Struct({
  namespace: Schema.String,
  binding: GoogleDiscoveryMethodBinding,
});

const encodeBindingEntry = Schema.encodeSync(Schema.parseJson(StoredBindingEntry));
const decodeBindingEntry = Schema.decodeUnknownSync(Schema.parseJson(StoredBindingEntry));

export interface GoogleDiscoveryStoredSource {
  readonly namespace: string;
  readonly name: string;
  readonly config: GoogleDiscoveryStoredSourceData;
}

export interface GoogleDiscoveryBindingStore {
  readonly get: (toolId: ToolId) => Effect.Effect<{
    namespace: string;
    binding: GoogleDiscoveryMethodBinding;
  } | null>;

  readonly put: (
    toolId: ToolId,
    namespace: string,
    binding: GoogleDiscoveryMethodBinding,
  ) => Effect.Effect<void>;

  readonly listByNamespace: (namespace: string) => Effect.Effect<readonly ToolId[]>;

  readonly removeByNamespace: (namespace: string) => Effect.Effect<readonly ToolId[]>;

  readonly putSource: (source: GoogleDiscoveryStoredSource) => Effect.Effect<void>;
  readonly removeSource: (namespace: string) => Effect.Effect<void>;
  readonly listSources: () => Effect.Effect<readonly GoogleDiscoveryStoredSource[]>;
  readonly getSource: (namespace: string) => Effect.Effect<GoogleDiscoveryStoredSource | null>;
  readonly getSourceConfig: (
    namespace: string,
  ) => Effect.Effect<GoogleDiscoveryStoredSourceData | null>;

  readonly putOAuthSession: (
    sessionId: string,
    session: GoogleDiscoveryOAuthSession,
  ) => Effect.Effect<void>;
  readonly getOAuthSession: (
    sessionId: string,
  ) => Effect.Effect<GoogleDiscoveryOAuthSession | null>;
  readonly deleteOAuthSession: (sessionId: string) => Effect.Effect<void>;
}

const makeStore = (
  bindings: ScopedKv,
  sources: ScopedKv,
  oauthSessions: ScopedKv,
): GoogleDiscoveryBindingStore => ({
  get: (toolId) =>
    Effect.gen(function* () {
      const raw = yield* bindings.get(toolId);
      if (!raw) return null;
      const entry = decodeBindingEntry(raw);
      return {
        namespace: entry.namespace,
        binding: entry.binding,
      };
    }),

  put: (toolId, namespace, binding) =>
    bindings.set([{ key: toolId, value: encodeBindingEntry({ namespace, binding }) }]),

  listByNamespace: (namespace) =>
    Effect.gen(function* () {
      const entries = yield* bindings.list();
      const ids: ToolId[] = [];
      for (const entry of entries) {
        const decoded = decodeBindingEntry(entry.value);
        if (decoded.namespace === namespace) {
          ids.push(entry.key as ToolId);
        }
      }
      return ids;
    }),

  removeByNamespace: (namespace) =>
    Effect.gen(function* () {
      const entries = yield* bindings.list();
      const ids: ToolId[] = [];
      for (const entry of entries) {
        const decoded = decodeBindingEntry(entry.value);
        if (decoded.namespace === namespace) ids.push(entry.key as ToolId);
      }
      if (ids.length > 0) yield* bindings.delete(ids);
      return ids;
    }),

  putSource: (source) => sources.set([{ key: source.namespace, value: JSON.stringify(source) }]),

  removeSource: (namespace) => sources.delete([namespace]).pipe(Effect.asVoid),

  listSources: () =>
    Effect.gen(function* () {
      const entries = yield* sources.list();
      return entries.map((e) => JSON.parse(e.value) as GoogleDiscoveryStoredSource);
    }),

  getSource: (namespace) =>
    Effect.gen(function* () {
      const raw = yield* sources.get(namespace);
      if (!raw) return null;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      return JSON.parse(raw) as GoogleDiscoveryStoredSource;
    }),

  getSourceConfig: (namespace) =>
    Effect.gen(function* () {
      const raw = yield* sources.get(namespace);
      if (!raw) return null;
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const source = JSON.parse(raw) as GoogleDiscoveryStoredSource;
      return source.config;
    }),

  // ---- Pending OAuth sessions (short-lived, between startOAuth and completeOAuth) ----

  putOAuthSession: (sessionId, session) =>
    oauthSessions.set([
      {
        key: sessionId,
        value: encodeOAuthSession({
          session,
          expiresAt: Date.now() + GOOGLE_DISCOVERY_OAUTH_SESSION_TTL_MS,
        }),
      },
    ]),

  getOAuthSession: (sessionId) =>
    Effect.gen(function* () {
      const raw = yield* oauthSessions.get(sessionId);
      if (!raw) return null;
      const entry = decodeOAuthSession(raw);
      if (entry.expiresAt < Date.now()) {
        yield* oauthSessions.delete([sessionId]);
        return null;
      }
      return entry.session;
    }),

  deleteOAuthSession: (sessionId) => oauthSessions.delete([sessionId]).pipe(Effect.asVoid),
});

export const makeKvBindingStore = (kv: Kv, namespace: string): GoogleDiscoveryBindingStore =>
  makeStore(
    scopeKv(kv, `${namespace}.bindings`),
    scopeKv(kv, `${namespace}.sources`),
    scopeKv(kv, `${namespace}.oauth-sessions`),
  );

export const makeInMemoryBindingStore = (): GoogleDiscoveryBindingStore =>
  makeStore(makeInMemoryScopedKv(), makeInMemoryScopedKv(), makeInMemoryScopedKv());

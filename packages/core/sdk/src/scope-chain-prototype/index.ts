// ---------------------------------------------------------------------------
// scope-chain-prototype
//
// Playground for the layered-scope primitive, now using the real SDK's
// Effect/Schema types and error channels. Still walled off from the rest
// of the SDK — this is a parallel universe where ScopeId is polymorphic
// (platform / org / workspace / user) and the stores take a chain instead
// of a single scope id.
//
// Concepts:
//   Layer       A Scope + a kind label. No parent field.
//   ScopeChain  Ordered list of Layers, narrowest first (PATH-style).
//   AuthScope   How a source decides which layer to write tokens to.
//   ChainSource An installed source. Lives at one layer; its tokens may
//               live at a different layer (determined by authScope).
//
// Rules:
//   - resolve walks the chain narrowest→widest, first hit wins
//   - list merges across the chain with shadow-dedup by id (narrower wins)
//   - pickAuthLayer decides *where OAuth writes* when a flow completes
//   - a miss is a clean failure — no silent fallback, no cross-user leakage
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";

import { ScopeId, SecretId } from "../ids";
import { SecretNotFoundError, SecretResolutionError } from "../errors";

// ---------- Layer ----------------------------------------------------------

/**
 * A layer is a Scope (id + name) plus a free-form `kind` label used by
 * authScope predicates. `kind` is intentionally a string — the system
 * doesn't enforce a closed enum so callers can introduce new kinds
 * (`team`, `folder`, `service-account`, ...) without plumbing changes.
 */
export class Layer extends Schema.Class<Layer>("PrototypeLayer")({
  id: ScopeId,
  kind: Schema.String,
  name: Schema.String,
}) {}

export const makeLayer = (kind: string) => (id: string, name: string): Layer =>
  new Layer({ id: ScopeId.make(id), kind, name });

export const platform = makeLayer("platform");
export const org = makeLayer("org");
export const workspace = makeLayer("workspace");
export const user = makeLayer("user");
export const serviceAccount = makeLayer("service-account");

export type ScopeChain = readonly Layer[];

// ---------- AuthScope ------------------------------------------------------

/**
 * Where a source writes its OAuth tokens when a flow completes.
 *
 *   inherit         — tokens live at the source's installed layer
 *   kind: "user"    — narrowest user-kind layer in the caller's chain
 *   pinned: scopeId — a specific scope id (must be in the chain)
 */
export type AuthScope =
  | { readonly type: "inherit" }
  | { readonly type: "kind"; readonly kind: string }
  | { readonly type: "pinned"; readonly scopeId: ScopeId };

// ---------- ChainSource ----------------------------------------------------

export class ChainSource extends Schema.Class<ChainSource>("PrototypeChainSource")({
  /** Logical source id (e.g. "gmail"). Stable across layers. */
  id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  /** Scope id where this source was installed. */
  installedAt: ScopeId,
}) {
  // authScope rides alongside the class instance — not round-tripped
  // through Schema in the prototype.
  readonly authScope!: AuthScope;
}

/**
 * Factory for ChainSource that attaches the non-schema `authScope` field.
 * Use this instead of `new ChainSource(...)` so authScope is never
 * silently dropped.
 */
export const makeChainSource = (input: {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly installedAt: ScopeId;
  readonly authScope: AuthScope;
}): ChainSource => {
  const src = new ChainSource({
    id: input.id,
    name: input.name,
    kind: input.kind,
    installedAt: input.installedAt,
  });
  (src as { authScope: AuthScope }).authScope = input.authScope;
  return src;
};

// ---------- Resolved<A> ----------------------------------------------------

/**
 * Result of a successful chain resolve. The `resolvedAt` layer is load-
 * bearing for write-backs (OAuth refresh rewrites at this layer, not at
 * the chain root).
 */
export interface Resolved<A> {
  readonly value: A;
  readonly resolvedAt: Layer;
}

// ---------- pickAuthLayer (pure) ------------------------------------------

export const pickAuthLayer = (
  source: ChainSource,
  chain: ScopeChain,
): Layer | null => {
  switch (source.authScope.type) {
    case "inherit":
      return chain.find((l) => l.id === source.installedAt) ?? null;
    case "kind": {
      const target = source.authScope.kind;
      return chain.find((l) => l.kind === target) ?? null;
    }
    case "pinned": {
      const target = source.authScope.scopeId;
      return chain.find((l) => l.id === target) ?? null;
    }
  }
};

// ---------- ChainSecretStore ----------------------------------------------

export interface SetChainSecretInput {
  readonly name: SecretId;
  readonly scopeId: ScopeId;
  readonly value: string;
}

/**
 * The shape a real SecretStore would grow if it took a chain.
 *
 * Differences from the existing SecretStore:
 *   - `resolve` takes a ScopeChain and returns Resolved<string>
 *     (value + which layer it came from)
 *   - secrets are keyed by (name, scopeId) rather than globally unique
 *     secret ids — "gmail:access" means something different at each layer
 */
export interface ChainSecretStore {
  readonly set: (input: SetChainSecretInput) => Effect.Effect<void>;
  readonly remove: (name: SecretId, scopeId: ScopeId) => Effect.Effect<boolean>;
  readonly resolve: (
    name: SecretId,
    chain: ScopeChain,
  ) => Effect.Effect<Resolved<string>, SecretNotFoundError>;
  readonly status: (
    name: SecretId,
    chain: ScopeChain,
  ) => Effect.Effect<"resolved" | "missing">;
  readonly listAtLayer: (
    scopeId: ScopeId,
  ) => Effect.Effect<readonly SecretId[]>;
}

export const makeChainSecretStore = (): ChainSecretStore => {
  // scopeId → (name → value)
  const byScope = new Map<ScopeId, Map<SecretId, string>>();

  const layerMap = (scopeId: ScopeId): Map<SecretId, string> => {
    let m = byScope.get(scopeId);
    if (!m) {
      m = new Map();
      byScope.set(scopeId, m);
    }
    return m;
  };

  const findInChain = (
    name: SecretId,
    chain: ScopeChain,
  ): Resolved<string> | null => {
    for (const l of chain) {
      const v = byScope.get(l.id)?.get(name);
      if (v !== undefined) return { value: v, resolvedAt: l };
    }
    return null;
  };

  return {
    set: (input) =>
      Effect.sync(() => {
        layerMap(input.scopeId).set(input.name, input.value);
      }),

    remove: (name, scopeId) =>
      Effect.sync(() => byScope.get(scopeId)?.delete(name) ?? false),

    resolve: (name, chain) =>
      Effect.gen(function* () {
        const hit = findInChain(name, chain);
        if (!hit) return yield* new SecretNotFoundError({ secretId: name });
        return hit;
      }),

    status: (name, chain) =>
      Effect.sync(() =>
        findInChain(name, chain) !== null ? "resolved" : "missing",
      ),

    listAtLayer: (scopeId) =>
      Effect.sync(() => [...(byScope.get(scopeId)?.keys() ?? [])]),
  };
};

// ---------- ChainSourceRegistry -------------------------------------------

export interface ChainSourceRegistry {
  readonly install: (source: ChainSource) => Effect.Effect<void>;
  readonly uninstall: (
    sourceId: string,
    scopeId: ScopeId,
  ) => Effect.Effect<boolean>;
  readonly list: (chain: ScopeChain) => Effect.Effect<readonly ChainSource[]>;
  readonly get: (
    sourceId: string,
    chain: ScopeChain,
  ) => Effect.Effect<ChainSource | null>;
}

export const makeChainSourceRegistry = (): ChainSourceRegistry => {
  // scopeId → (sourceId → ChainSource)
  const byScope = new Map<ScopeId, Map<string, ChainSource>>();

  const layerMap = (scopeId: ScopeId): Map<string, ChainSource> => {
    let m = byScope.get(scopeId);
    if (!m) {
      m = new Map();
      byScope.set(scopeId, m);
    }
    return m;
  };

  const listInChain = (chain: ScopeChain): readonly ChainSource[] => {
    const seen = new Map<string, ChainSource>();
    for (const l of chain) {
      const m = byScope.get(l.id);
      if (!m) continue;
      for (const [id, src] of m) {
        if (!seen.has(id)) seen.set(id, src);
      }
    }
    return [...seen.values()];
  };

  return {
    install: (source) =>
      Effect.sync(() => {
        layerMap(source.installedAt).set(source.id, source);
      }),

    uninstall: (sourceId, scopeId) =>
      Effect.sync(() => byScope.get(scopeId)?.delete(sourceId) ?? false),

    list: (chain) => Effect.sync(() => listInChain(chain)),

    get: (sourceId, chain) =>
      Effect.sync(() => listInChain(chain).find((s) => s.id === sourceId) ?? null),
  };
};

// ---------- OAuth simulation helpers --------------------------------------

/**
 * Simulate a completed OAuth flow: compute the write target from the
 * source's authScope, then write the access/refresh tokens at that layer.
 *
 * Fails with SecretResolutionError if no layer in the chain satisfies
 * the authScope predicate (e.g. a headless agent with no user layer
 * attempting to OAuth a per-user source).
 */
export const completeOAuth = (
  secrets: ChainSecretStore,
  source: ChainSource,
  chain: ScopeChain,
  tokens: { readonly access: string; readonly refresh?: string },
): Effect.Effect<Layer, SecretResolutionError> =>
  Effect.gen(function* () {
    const target = pickAuthLayer(source, chain);
    if (!target) {
      return yield* new SecretResolutionError({
        secretId: SecretId.make(`${source.id}:access`),
        message:
          `No layer in chain matches authScope ${JSON.stringify(source.authScope)} ` +
          `for source ${source.id}`,
      });
    }
    yield* secrets.set({
      name: SecretId.make(`${source.id}:access`),
      scopeId: target.id,
      value: tokens.access,
    });
    if (tokens.refresh !== undefined) {
      yield* secrets.set({
        name: SecretId.make(`${source.id}:refresh`),
        scopeId: target.id,
        value: tokens.refresh,
      });
    }
    return target;
  });

/**
 * Simulate refresh-in-place: resolve the current access token, mint a new
 * one, and write it back at *the same layer* the original was resolved
 * from. This is the key invariant — refresh never migrates tokens between
 * layers.
 */
export const refreshInPlace = (
  secrets: ChainSecretStore,
  source: ChainSource,
  chain: ScopeChain,
  mintNewAccess: () => string,
): Effect.Effect<Resolved<string>, SecretNotFoundError> =>
  Effect.gen(function* () {
    const name = SecretId.make(`${source.id}:access`);
    const current = yield* secrets.resolve(name, chain);
    const next = mintNewAccess();
    yield* secrets.set({ name, scopeId: current.resolvedAt.id, value: next });
    return { value: next, resolvedAt: current.resolvedAt };
  });

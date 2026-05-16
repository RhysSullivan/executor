import { Effect } from "effect";

import type { SecretRow } from "./core-schema";
import { byId, byScopedId, makeCoreDb, scopedWhere } from "./executor-helpers";
import { SecretInUseError, SecretOwnedByConnectionError } from "./errors";
import { StorageError, type StorageFailure } from "./fuma-runtime";
import { ConnectionId, ScopeId, SecretId } from "./ids";
import { RemoveSecretInput, SecretRef, SetSecretInput, type SecretProvider } from "./secrets";
import { Usage } from "./usages";
import type { PluginCtx } from "./plugin";

type PluginRuntime = {
  readonly plugin: {
    readonly id: string;
    readonly usagesForSecret?: (input: {
      readonly ctx: PluginCtx<unknown>;
      readonly args: { readonly secretId: SecretId };
    }) => Effect.Effect<readonly Usage[], unknown>;
    readonly usagesForConnection?: (input: {
      readonly ctx: PluginCtx<unknown>;
      readonly args: { readonly connectionId: ConnectionId };
    }) => Effect.Effect<readonly Usage[], unknown>;
  };
  readonly ctx: PluginCtx<unknown>;
};

export const makeSecretsFacade = (deps: {
  readonly core: ReturnType<typeof makeCoreDb>;
  readonly scopeIds: readonly string[];
  readonly scopePrecedence: ReadonlyMap<string, number>;
  readonly scopeRank: (row: { readonly scope_id: unknown }) => number;
  readonly secretProviders: ReadonlyMap<string, SecretProvider>;
  readonly runtimes: ReadonlyMap<string, PluginRuntime>;
  readonly findSecretRowAtScope: (input: {
    readonly secretId: string;
    readonly scopeId: string;
  }) => Effect.Effect<SecretRow | null, StorageFailure>;
  readonly assertScopeInStack: (
    label: string,
    scopeId: string,
  ) => Effect.Effect<void, StorageError>;
  readonly credentialBindingUsagesForSecret: (
    id: string,
  ) => Effect.Effect<readonly Usage[], StorageFailure>;
  readonly credentialBindingUsagesForConnection: (
    id: string,
  ) => Effect.Effect<readonly Usage[], StorageFailure>;
}) => {
  const {
    core,
    scopeIds,
    scopePrecedence,
    scopeRank,
    secretProviders,
    runtimes,
    findSecretRowAtScope,
    assertScopeInStack,
    credentialBindingUsagesForSecret,
    credentialBindingUsagesForConnection,
  } = deps;

  const filterUsagesToScopeStack = (usages: readonly Usage[]): readonly Usage[] =>
    usages.filter((usage) => scopeIds.includes(usage.scopeId));

  const secretRowsForId = (id: string): Effect.Effect<readonly SecretRow[], StorageFailure> =>
    core.findMany("secret", { where: scopedWhere(scopeIds, byId(id)) }) as Effect.Effect<
      readonly SecretRow[],
      StorageFailure
    >;

  const resolveSecretValueFromRows = (
    id: string,
    rows: readonly SecretRow[],
  ): Effect.Effect<string | null, StorageFailure> =>
    Effect.gen(function* () {
      const ordered = [...rows].sort((a, b) => scopeRank(a) - scopeRank(b));
      for (const row of ordered) {
        const provider = secretProviders.get(row.provider);
        if (!provider) continue;
        const value = yield* provider.get(id, row.scope_id);
        if (value !== null) return value;
      }

      // Fallback: ask enumerating providers in registration order. First
      // non-null wins. Providers that throw
      // are treated as "don't have it" so one flaky provider can't
      // block resolution via others. Scope-partitioning providers
      // get asked at the innermost scope as a display default — the
      // enumeration fallback doesn't know which scope the value
      // lives in; flat providers ignore the arg.
      const fallbackScope = scopeIds[0]!;
      const candidates = [...secretProviders.values()].filter(
        (p) => p.list && p.allowFallback !== false,
      );
      for (const provider of candidates) {
        const value = yield* provider
          .get(id, fallbackScope)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (value !== null) return value;
      }
      return null;
    });

  const secretsGet = (
    id: string,
  ): Effect.Effect<string | null, SecretOwnedByConnectionError | StorageFailure> =>
    Effect.gen(function* () {
      // Connection-owned token rows are internal plumbing; public secret
      // resolution must not expose them even if a token secret id is leaked.
      const rows = yield* secretRowsForId(id);
      const owned = rows.find((row) => row.owned_by_connection_id);
      const ownedByConnectionId = owned?.owned_by_connection_id;
      if (ownedByConnectionId) {
        return yield* new SecretOwnedByConnectionError({
          secretId: SecretId.make(id),
          connectionId: ConnectionId.make(ownedByConnectionId),
        });
      }
      return yield* resolveSecretValueFromRows(id, rows);
    });

  const secretsGetResolved = (
    id: string,
  ): Effect.Effect<
    { readonly value: string; readonly scopeId: string | null } | null,
    StorageFailure
  > =>
    Effect.gen(function* () {
      const rows = yield* secretRowsForId(id);
      const ordered = [...rows].sort((a, b) => scopeRank(a) - scopeRank(b));
      for (const row of ordered) {
        if (row.owned_by_connection_id) continue;
        const value = yield* resolveSecretValueAtScope(row, id);
        if (value !== null) return { value, scopeId: row.scope_id };
      }
      const value = yield* resolveSecretValueFromRows(id, []);
      return value === null ? null : { value, scopeId: null };
    });

  const resolveSecretValueAtScope = (
    row: SecretRow | null,
    id: string,
  ): Effect.Effect<string | null, StorageFailure> =>
    Effect.gen(function* () {
      if (!row) return null;
      const provider = secretProviders.get(row.provider);
      if (!provider) return null;
      return yield* provider.get(id, row.scope_id);
    });

  const secretsGetAtScope = (
    id: string,
    scope: string,
  ): Effect.Effect<string | null, SecretOwnedByConnectionError | StorageFailure> =>
    Effect.gen(function* () {
      yield* assertScopeInStack("secret get scope", scope);
      const row = yield* findSecretRowAtScope({
        secretId: id,
        scopeId: scope,
      });
      if (row?.owned_by_connection_id) {
        return yield* new SecretOwnedByConnectionError({
          secretId: SecretId.make(id),
          connectionId: ConnectionId.make(row.owned_by_connection_id),
        });
      }
      return yield* resolveSecretValueAtScope(row, id);
    });

  const connectionSecretGetAtScope = (
    id: string,
    scope: string,
  ): Effect.Effect<string | null, StorageFailure> =>
    Effect.gen(function* () {
      yield* assertScopeInStack("connection secret get scope", scope);
      const row = yield* findSecretRowAtScope({
        secretId: id,
        scopeId: scope,
      });
      return yield* resolveSecretValueAtScope(row, id);
    });

  const secretRouteHasBackingValue = (row: SecretRow) => {
    const provider = secretProviders.get(row.provider);
    if (!provider?.has) return Effect.succeed(true);
    return provider.has(row.id, row.scope_id).pipe(Effect.catch(() => Effect.succeed(false)));
  };

  const secretsSet = (input: SetSecretInput): Effect.Effect<SecretRef, StorageFailure> =>
    Effect.gen(function* () {
      // Validate the write target before we touch the provider.
      if (!scopeIds.includes(input.scope)) {
        return yield* new StorageError({
          message:
            `secrets.set targets scope "${input.scope}" which is not ` +
            `in the executor's scope stack [${scopeIds.join(", ")}].`,
          cause: undefined,
        });
      }

      // Pick provider: explicit or first-writable. Misconfiguration
      // (unknown provider, no writable provider, read-only provider)
      // is a host setup bug — surface as `StorageError` so it lands
      // as a captured InternalError(traceId) at the SDK boundary.
      let target: SecretProvider | undefined;
      if (input.provider) {
        target = secretProviders.get(input.provider);
        if (!target) {
          return yield* new StorageError({
            message: `Unknown secret provider: ${input.provider}`,
            cause: undefined,
          });
        }
      } else {
        for (const provider of secretProviders.values()) {
          if (provider.writable && provider.set) {
            target = provider;
            break;
          }
        }
        if (!target) {
          return yield* new StorageError({
            message: "No writable secret providers registered",
            cause: undefined,
          });
        }
      }
      if (!target.writable || !target.set) {
        return yield* new StorageError({
          message: `Secret provider "${target.key}" is read-only`,
          cause: undefined,
        });
      }

      yield* target.set(input.id, input.value, input.scope);

      // Upsert metadata row in the core `secret` table at the
      // caller-named scope. Pin the delete to `scope_id = input.scope`
      // so a personal override never deletes an org-wide secret with
      // the same id.
      const now = new Date();
      yield* core.deleteMany("secret", {
        where: byScopedId(input.scope, input.id),
      });
      yield* core.create("secret", {
        id: input.id,
        scope_id: input.scope,
        name: input.name,
        provider: target.key,
        owned_by_connection_id: null,
        created_at: now,
      });

      return SecretRef.make({
        id: input.id,
        scopeId: input.scope,
        name: input.name,
        provider: target.key,
        createdAt: now,
      });
    });

  // Fan out across every plugin that contributes `usagesForSecret`. Each
  // plugin queries its own normalized columns with explicit scope filters.
  //
  // The display path (`secretsUsages` / `connectionsUsages` from the API)
  // calls `*Lenient`: per-plugin errors become a logWarning so one buggy
  // plugin can't break the UI footer. The delete RESTRICT path
  // (`secretsRemove` / `connectionsRemove`) calls `*Strict`: per-plugin
  // errors fail the whole call so a transient plugin failure can't be
  // mistaken for "no usages" and let through a delete that creates
  // dangling refs.
  const secretsUsagesStrict = (id: string): Effect.Effect<readonly Usage[], StorageFailure> =>
    Effect.gen(function* () {
      const secretId = SecretId.make(id);
      const coreUsages = yield* credentialBindingUsagesForSecret(id);
      const perPlugin = yield* Effect.all(
        [...runtimes.values()]
          .filter((r) => r.plugin.usagesForSecret)
          .map((r) =>
            r.plugin.usagesForSecret!({
              ctx: r.ctx,
              args: { secretId },
            }).pipe(
              Effect.mapError(
                (cause): StorageFailure =>
                  new StorageError({
                    message: `usagesForSecret failed for plugin ${r.plugin.id}`,
                    cause,
                  }),
              ),
            ),
          ),
        { concurrency: "unbounded" },
      );
      return filterUsagesToScopeStack([...coreUsages, ...perPlugin.flat()]);
    });

  const secretsUsages = (id: string): Effect.Effect<readonly Usage[], StorageFailure> =>
    Effect.gen(function* () {
      const secretId = SecretId.make(id);
      const coreUsages = yield* credentialBindingUsagesForSecret(id);
      const perPlugin = yield* Effect.all(
        [...runtimes.values()]
          .filter((r) => r.plugin.usagesForSecret)
          .map((r) =>
            r.plugin.usagesForSecret!({
              ctx: r.ctx,
              args: { secretId },
            }).pipe(
              Effect.catchCause((cause: unknown) =>
                Effect.logWarning(`usagesForSecret failed for plugin ${r.plugin.id}`, cause).pipe(
                  Effect.as([] as readonly Usage[]),
                ),
              ),
            ),
          ),
        { concurrency: "unbounded" },
      );
      return filterUsagesToScopeStack([...coreUsages, ...perPlugin.flat()]);
    });

  const connectionsUsagesStrict = (id: string): Effect.Effect<readonly Usage[], StorageFailure> =>
    Effect.gen(function* () {
      const connectionId = ConnectionId.make(id);
      const coreUsages = yield* credentialBindingUsagesForConnection(id);
      const perPlugin = yield* Effect.all(
        [...runtimes.values()]
          .filter((r) => r.plugin.usagesForConnection)
          .map((r) =>
            r.plugin.usagesForConnection!({
              ctx: r.ctx,
              args: { connectionId },
            }).pipe(
              Effect.mapError(
                (cause): StorageFailure =>
                  new StorageError({
                    message: `usagesForConnection failed for plugin ${r.plugin.id}`,
                    cause,
                  }),
              ),
            ),
          ),
        { concurrency: "unbounded" },
      );
      return filterUsagesToScopeStack([...coreUsages, ...perPlugin.flat()]);
    });

  const connectionsUsages = (id: string): Effect.Effect<readonly Usage[], StorageFailure> =>
    Effect.gen(function* () {
      const connectionId = ConnectionId.make(id);
      const coreUsages = yield* credentialBindingUsagesForConnection(id);
      const perPlugin = yield* Effect.all(
        [...runtimes.values()]
          .filter((r) => r.plugin.usagesForConnection)
          .map((r) =>
            r.plugin.usagesForConnection!({
              ctx: r.ctx,
              args: { connectionId },
            }).pipe(
              Effect.catchCause((cause: unknown) =>
                Effect.logWarning(
                  `usagesForConnection failed for plugin ${r.plugin.id}`,
                  cause,
                ).pipe(Effect.as([] as readonly Usage[])),
              ),
            ),
          ),
        { concurrency: "unbounded" },
      );
      return filterUsagesToScopeStack([...coreUsages, ...perPlugin.flat()]);
    });

  const secretsRemove = (
    input: RemoveSecretInput,
  ): Effect.Effect<void, SecretOwnedByConnectionError | SecretInUseError | StorageFailure> =>
    Effect.gen(function* () {
      const id = input.id;
      const targetScope = input.targetScope;
      if (!scopeIds.includes(targetScope)) {
        return yield* new StorageError({
          message:
            `secret remove targetScope "${targetScope}" is not in the executor's scope stack ` +
            `[${scopeIds.join(", ")}].`,
          cause: undefined,
        });
      }

      // Remove is target-scope aware: drop only the explicitly named
      // scope row. Removing a user-scope override on a secret that also
      // has an org-scope default should reveal the org default, not wipe
      // it. If no core row exists at the target scope, provider cleanup
      // is still scoped to the explicit target for provider-enumerated
      // secrets, but core metadata never falls through to an outer row.
      const rows = yield* core.findMany("secret", {
        where: scopedWhere(scopeIds, byId(id)),
      });
      const target = rows.find((row) => row.scope_id === targetScope);
      // Refuse to delete connection-owned secrets. The connection owns
      // the lifecycle — callers must go through connections.remove.
      if (target && target.owned_by_connection_id) {
        return yield* new SecretOwnedByConnectionError({
          secretId: SecretId.make(id),
          connectionId: ConnectionId.make(target.owned_by_connection_id),
        });
      }
      // RESTRICT: source/binding rows are pinned to the credential row's
      // scope. A same-id row in an outer scope does not satisfy a binding
      // written at the target scope, so the delete gate filters usages to
      // the exact row being removed.
      if (target) {
        const usages = (yield* secretsUsagesStrict(id)).filter(
          (usage) => usage.scopeId === targetScope,
        );
        if (usages.length > 0) {
          return yield* new SecretInUseError({
            secretId: SecretId.make(id),
            usageCount: usages.length,
          });
        }
      }

      const deleters = [...secretProviders.values()].filter(
        (p): p is typeof p & { delete: NonNullable<typeof p.delete> } => !!(p.writable && p.delete),
      );
      yield* Effect.all(
        deleters.map((p) => p.delete(id, targetScope)),
        { concurrency: "unbounded" },
      );

      if (target) {
        yield* core.deleteMany("secret", {
          where: byScopedId(targetScope, id),
        });
      }
    });

  // List is a union of two sources of truth:
  //
  //   1. Core `secret` rows — secrets explicitly registered via
  //      executor.secrets.set(...). These carry their pinned provider
  //      and are authoritative for routing (get() uses them).
  //   2. Each provider's own `list()` — for read-only or
  //      already-populated providers (1password, file-secrets,
  //      workos-vault, env), the provider enumerates what's actually
  //      in its backend. These show up in the list even if the user
  //      never called set() through the executor.
  //
  // Dedupe by secret id; core rows win over provider-enumerated ones
  // so that routing information in the core table is authoritative.
  // Providers without a list() method (e.g. keychain) contribute
  // only via the core table path.
  //
  // Multi-scope: core rows from any scope in the stack show up, each
  // tagged with its own `scope_id`. When the same id appears in multiple scopes, the
  // innermost wins — same rule as `secretsGet`. Provider-enumerated
  // entries don't know what scope they belong to and are attributed
  // to the innermost scope as a display default.
  const secretsList = (): Effect.Effect<readonly SecretRef[], StorageFailure> =>
    Effect.gen(function* () {
      const byId = new Map<string, SecretRef>();

      // Core routing rows first. Resolve collisions using the caller's
      // precedence order (innermost first). Rows owned by a connection
      // are filtered out — the user sees the Connection entry, not its
      // backing token secrets. Their ids go in a deny-set so provider
      // `list()` results for the same id can't leak them back in below.
      const allRows = yield* core.findMany("secret", { where: scopedWhere(scopeIds) });
      const rows = allRows.filter((r) => !r.owned_by_connection_id);
      const pick = (row: (typeof rows)[number]) => {
        const existing = byId.get(row.id);
        const incomingScope = row.scope_id;
        const incomingRank = scopeRank(row);
        if (existing) {
          const existingRank = scopePrecedence.get(existing.scopeId) ?? Infinity;
          if (existingRank <= incomingRank) return;
        }
        byId.set(
          row.id,
          SecretRef.make({
            id: SecretId.make(row.id),
            scopeId: ScopeId.make(incomingScope),
            name: row.name,
            provider: row.provider,
            createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
          }),
        );
      };
      for (const row of rows) {
        const hasBackingValue = yield* secretRouteHasBackingValue(row);
        if (hasBackingValue) pick(row);
      }

      // Don't let provider-enumerated entries resurrect ids that
      // belong to a connection-owned core row.
      const connectionOwnedIds = new Set(
        allRows.filter((r) => r.owned_by_connection_id).map((r) => r.id),
      );
      // Attribute provider-listed entries to the innermost scope as
      // a display default — providers like 1password and env don't
      // partition their inventory by executor scope.
      const innermostScopeId = scopeIds[0];
      if (innermostScopeId !== undefined) {
        for (const [key, provider] of secretProviders) {
          if (!provider.list) continue;
          const entries = yield* provider
            .list()
            .pipe(Effect.catch(() => Effect.succeed([] as const)));
          for (const entry of entries) {
            if (byId.has(entry.id)) continue;
            if (connectionOwnedIds.has(entry.id)) continue;
            byId.set(
              entry.id,
              SecretRef.make({
                id: SecretId.make(entry.id),
                scopeId: ScopeId.make(innermostScopeId),
                name: entry.name,
                provider: key,
                createdAt: new Date(0),
              }),
            );
          }
        }
      }

      return Array.from(byId.values());
    });

  const secretsListAll = (): Effect.Effect<readonly SecretRef[], StorageFailure> =>
    Effect.gen(function* () {
      const allRows = yield* core.findMany("secret", { where: scopedWhere(scopeIds) });
      const coreIds = new Set<string>();
      const refs: SecretRef[] = [];

      for (const row of allRows) {
        coreIds.add(row.id);
        if (row.owned_by_connection_id) continue;
        const hasBackingValue = yield* secretRouteHasBackingValue(row);
        if (!hasBackingValue) continue;
        refs.push(
          SecretRef.make({
            id: SecretId.make(row.id),
            scopeId: ScopeId.make(row.scope_id),
            name: row.name,
            provider: row.provider,
            createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
          }),
        );
      }

      return refs.sort((a, b) => {
        const rank =
          (scopePrecedence.get(a.scopeId) ?? Infinity) -
          (scopePrecedence.get(b.scopeId) ?? Infinity);
        if (rank !== 0) return rank;
        const name = a.name.localeCompare(b.name);
        return name === 0 ? String(a.id).localeCompare(String(b.id)) : name;
      });
    });

  // Same union shape as secretsList but projected to the leaner
  // SecretListEntry shape that plugins get via ctx.secrets.list().
  const secretsListForCtx = () =>
    Effect.gen(function* () {
      const list = yield* secretsList();
      return list.map((ref) => ({
        id: String(ref.id),
        name: ref.name,
        provider: ref.provider,
      }));
    });

  // Existence check for user-facing secret pickers. Core `secret` rows are routing metadata;
  // when a provider can answer `has()`, confirm the backing value still exists.
  const status = (id: string): Effect.Effect<"resolved" | "missing", StorageFailure> =>
    Effect.gen(function* () {
      const rows = yield* secretRowsForId(id);
      if (rows.some((row) => row.owned_by_connection_id)) return "missing";
      for (const row of rows) {
        if (yield* secretRouteHasBackingValue(row)) return "resolved";
      }

      return "missing";
    });

  return {
    connectionSecretGetAtScope,
    connectionsUsages,
    connectionsUsagesStrict,
    get: secretsGet,
    getAtScope: secretsGetAtScope,
    getResolved: secretsGetResolved,
    list: secretsList,
    listAll: secretsListAll,
    listForCtx: secretsListForCtx,
    remove: secretsRemove,
    routeHasBackingValue: secretRouteHasBackingValue,
    set: secretsSet,
    status,
    usages: secretsUsages,
    usagesStrict: secretsUsagesStrict,
  };
};

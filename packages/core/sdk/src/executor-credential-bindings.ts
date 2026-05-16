import { Effect } from "effect";

import {
  credentialBindingId,
  credentialBindingRowToRef,
  ResolvedCredentialSlot,
  type CredentialBindingRef,
  type CredentialBindingsFacade,
  type CredentialBindingSlotInput,
  type CredentialBindingSourceInput,
  type RemoveCredentialBindingInput,
  type ReplaceCredentialBindingsInput,
  type SetCredentialBindingInput,
} from "./credential-bindings";
import type { ConnectionRow, CredentialBindingRow, SecretRow, SourceRow } from "./core-schema";
import { makeCoreDb, scopedWhere } from "./executor-helpers";
import { StorageError, type StorageFailure } from "./fuma-runtime";
import { ScopeId } from "./ids";
import type { SecretProvider } from "./secrets";
import { Usage } from "./usages";

export const makeCredentialBindings = (deps: {
  readonly core: ReturnType<typeof makeCoreDb>;
  readonly scopeIds: readonly string[];
  readonly scopePrecedence: ReadonlyMap<string, number>;
  readonly scopeRank: (row: { readonly scope_id: unknown }) => number;
  readonly findInnermost: <T extends { readonly scope_id: unknown }>(
    rows: readonly T[],
  ) => T | null;
  readonly assertScopeInStack: (
    label: string,
    scopeId: string,
  ) => Effect.Effect<void, StorageError>;
  readonly findSourceRowAtScope: (input: {
    readonly pluginId: string;
    readonly sourceId: string;
    readonly sourceScope: string;
  }) => Effect.Effect<SourceRow | null, StorageFailure>;
  readonly findSecretRowAtScope: (input: {
    readonly secretId: string;
    readonly scopeId: string;
  }) => Effect.Effect<SecretRow | null, StorageFailure>;
  readonly findConnectionRowAtScope: (input: {
    readonly connectionId: string;
    readonly scopeId: string;
  }) => Effect.Effect<ConnectionRow | null, StorageFailure>;
  readonly secretProviders: ReadonlyMap<string, SecretProvider>;
  readonly secretRouteHasBackingValue: (row: SecretRow) => Effect.Effect<boolean, StorageFailure>;
}): CredentialBindingsFacade => {
  const {
    core,
    scopeIds,
    scopePrecedence,
    scopeRank,
    findInnermost,
    assertScopeInStack,
    findSourceRowAtScope,
    findSecretRowAtScope,
    findConnectionRowAtScope,
    secretProviders,
    secretRouteHasBackingValue,
  } = deps;

  const credentialBindingRowsForSource = (
    input: CredentialBindingSourceInput,
  ): Effect.Effect<readonly CredentialBindingRow[], StorageFailure> =>
    scopeIds.includes(input.sourceScope)
      ? (core
          .findMany("credential_binding", {
            where: scopedWhere(scopeIds, (b) =>
              b.and(
                b("plugin_id", "=", input.pluginId),
                b("source_id", "=", input.sourceId),
                b("source_scope_id", "=", input.sourceScope),
              ),
            ),
          })
          .pipe(
            Effect.map((rows) => {
              const sourceSourceRank = scopePrecedence.get(input.sourceScope) ?? Infinity;
              return (rows as readonly CredentialBindingRow[]).filter(
                (row) => scopeRank(row) <= sourceSourceRank,
              );
            }),
          ) as Effect.Effect<readonly CredentialBindingRow[], StorageFailure>)
      : Effect.succeed([]);

  const credentialBindingRowsForSlot = (
    input: CredentialBindingSlotInput,
  ): Effect.Effect<readonly CredentialBindingRow[], StorageFailure> =>
    scopeIds.includes(input.sourceScope)
      ? (core
          .findMany("credential_binding", {
            where: scopedWhere(scopeIds, (b) =>
              b.and(
                b("plugin_id", "=", input.pluginId),
                b("source_id", "=", input.sourceId),
                b("source_scope_id", "=", input.sourceScope),
                b("slot_key", "=", input.slotKey),
              ),
            ),
          })
          .pipe(
            Effect.map((rows) => {
              const sourceSourceRank = scopePrecedence.get(input.sourceScope) ?? Infinity;
              return (rows as readonly CredentialBindingRow[]).filter(
                (row) => scopeRank(row) <= sourceSourceRank,
              );
            }),
          ) as Effect.Effect<readonly CredentialBindingRow[], StorageFailure>)
      : Effect.succeed([]);

  const assertCredentialBindingTargetNotOuter = (input: {
    readonly label: string;
    readonly targetScope: string;
    readonly sourceScope: string;
    readonly sourceId: string;
  }): Effect.Effect<void, StorageFailure> =>
    Effect.gen(function* () {
      const sourceSourceRank = scopePrecedence.get(input.sourceScope) ?? Infinity;
      const targetRank = scopePrecedence.get(input.targetScope) ?? Infinity;
      if (targetRank > sourceSourceRank) {
        return yield* new StorageError({
          message:
            `${input.label} for source "${input.sourceId}" cannot target outer scope ` +
            `"${input.targetScope}" because the source lives at scope "${input.sourceScope}".`,
          cause: undefined,
        });
      }
    });

  const credentialBindingListForSource = (input: CredentialBindingSourceInput) =>
    Effect.gen(function* () {
      const rows = yield* credentialBindingRowsForSource(input);
      return rows
        .slice()
        .sort((a, b) => {
          const slot = a.slot_key.localeCompare(b.slot_key);
          return slot === 0 ? scopeRank(a) - scopeRank(b) : slot;
        })
        .map(credentialBindingRowToRef);
    });

  const credentialBindingSet = (input: SetCredentialBindingInput) =>
    Effect.gen(function* () {
      yield* assertScopeInStack("credential binding targetScope", input.targetScope);
      yield* assertScopeInStack("credential binding sourceScope", input.sourceScope);
      yield* assertCredentialBindingTargetNotOuter({
        label: "credential binding",
        targetScope: input.targetScope,
        sourceScope: input.sourceScope,
        sourceId: input.sourceId,
      });

      const source = yield* findSourceRowAtScope({
        pluginId: input.pluginId,
        sourceId: input.sourceId,
        sourceScope: input.sourceScope,
      });
      if (!source) {
        return yield* new StorageError({
          message:
            `Cannot set credential binding for source "${input.sourceId}" ` +
            `at scope "${input.sourceScope}": source is not visible.`,
          cause: undefined,
        });
      }

      if (input.value.kind === "secret") {
        const secretId = input.value.secretId;
        const secretScope = input.value.secretScopeId ?? input.targetScope;
        yield* assertScopeInStack("credential binding secretScope", secretScope);
        if (scopePrecedence.get(secretScope)! < scopePrecedence.get(input.targetScope)!) {
          return yield* new StorageError({
            message:
              `Cannot bind secret "${secretId}" from scope "${secretScope}" ` +
              `to target scope "${input.targetScope}": shared bindings cannot reference inner-scope secrets.`,
            cause: undefined,
          });
        }
        const secret = yield* findSecretRowAtScope({
          secretId,
          scopeId: secretScope,
        });
        if (!secret) {
          // No core routing row at this scope yet. Read-only providers
          // (1password, env, …) own items that never get a row via
          // `secrets.set()`, so a config-sync referencing one of those
          // ids by value otherwise fails here. Walk providers that can
          // enumerate, and if any owns the id, materialize a routing row
          // pointing at that provider so resolution finds it.
          let materialized = false;
          for (const [key, provider] of secretProviders) {
            let name: string | undefined;
            if (provider.list) {
              const entries = yield* provider
                .list()
                .pipe(Effect.catch(() => Effect.succeed([] as const)));
              const found = entries.find((e) => e.id === secretId);
              if (found) name = found.name;
            }
            if (name === undefined) {
              // Provider didn't enumerate the id (slow list(), failed list,
              // or no list() at all). Probe with get() — cheap for most
              // backends — and use the id as the display name.
              const value = yield* provider
                .get(secretId, secretScope)
                .pipe(Effect.catch(() => Effect.succeed(null as string | null)));
              if (value !== null) name = secretId;
            }
            if (name === undefined) continue;
            const now = new Date();
            yield* core.create("secret", {
              id: secretId,
              scope_id: secretScope,
              name,
              provider: key,
              owned_by_connection_id: null,
              created_at: now,
            });
            materialized = true;
            break;
          }
          if (!materialized) {
            const providerKeys = [...secretProviders.keys()];
            return yield* new StorageError({
              message:
                `Cannot bind secret "${secretId}" at scope "${secretScope}": ` +
                `no registered secret provider has an item with this id ` +
                `(checked: ${providerKeys.join(", ") || "none"}). ` +
                `If this id points to a 1Password item, the item may have been deleted, ` +
                `renamed, or live in a different vault than the one configured for this scope.`,
              cause: undefined,
            });
          }
        }
      }

      if (input.value.kind === "connection") {
        const connection = yield* findConnectionRowAtScope({
          connectionId: input.value.connectionId,
          scopeId: input.targetScope,
        });
        if (!connection) {
          return yield* new StorageError({
            message:
              `Cannot bind connection "${input.value.connectionId}" at scope "${input.targetScope}": ` +
              `the connection must be owned by the same scope as the binding.`,
            cause: undefined,
          });
        }
      }

      const id = credentialBindingId(input);
      const now = new Date();
      yield* core.deleteMany("credential_binding", {
        where: (b) =>
          b.and(
            b("scope_id", "=", input.targetScope),
            b("plugin_id", "=", input.pluginId),
            b("source_id", "=", input.sourceId),
            b("source_scope_id", "=", input.sourceScope),
            b("slot_key", "=", input.slotKey),
          ),
      });
      yield* core.create("credential_binding", {
        id,
        scope_id: input.targetScope,
        plugin_id: input.pluginId,
        source_id: input.sourceId,
        source_scope_id: input.sourceScope,
        slot_key: input.slotKey,
        kind: input.value.kind,
        text_value: input.value.kind === "text" ? input.value.text : null,
        secret_id: input.value.kind === "secret" ? input.value.secretId : null,
        secret_scope_id:
          input.value.kind === "secret" ? (input.value.secretScopeId ?? input.targetScope) : null,
        connection_id: input.value.kind === "connection" ? input.value.connectionId : null,
        created_at: now,
        updated_at: now,
      });
      return credentialBindingRowToRef({
        id,
        scope_id: input.targetScope,
        plugin_id: input.pluginId,
        source_id: input.sourceId,
        source_scope_id: input.sourceScope,
        slot_key: input.slotKey,
        kind: input.value.kind,
        text_value: input.value.kind === "text" ? input.value.text : undefined,
        secret_id: input.value.kind === "secret" ? input.value.secretId : undefined,
        secret_scope_id:
          input.value.kind === "secret"
            ? (input.value.secretScopeId ?? input.targetScope)
            : undefined,
        connection_id: input.value.kind === "connection" ? input.value.connectionId : undefined,
        created_at: now,
        updated_at: now,
      } as CredentialBindingRow);
    });

  const credentialBindingRemove = (input: RemoveCredentialBindingInput) =>
    Effect.gen(function* () {
      yield* assertScopeInStack("credential binding targetScope", input.targetScope);
      yield* assertScopeInStack("credential binding sourceScope", input.sourceScope);
      yield* assertCredentialBindingTargetNotOuter({
        label: "credential binding removal",
        targetScope: input.targetScope,
        sourceScope: input.sourceScope,
        sourceId: input.sourceId,
      });

      const source = yield* findSourceRowAtScope({
        pluginId: input.pluginId,
        sourceId: input.sourceId,
        sourceScope: input.sourceScope,
      });
      if (!source) {
        return yield* new StorageError({
          message:
            `Cannot remove credential binding for source "${input.sourceId}" ` +
            `at scope "${input.sourceScope}": source is not visible.`,
          cause: undefined,
        });
      }

      yield* core.deleteMany("credential_binding", {
        where: (b) =>
          b.and(
            b("scope_id", "=", input.targetScope),
            b("plugin_id", "=", input.pluginId),
            b("source_id", "=", input.sourceId),
            b("source_scope_id", "=", input.sourceScope),
            b("slot_key", "=", input.slotKey),
          ),
      });
    });

  const credentialBindingReplaceForSource = (input: ReplaceCredentialBindingsInput) =>
    Effect.gen(function* () {
      yield* assertScopeInStack("credential binding targetScope", input.targetScope);
      yield* assertScopeInStack("credential binding sourceScope", input.sourceScope);
      yield* assertCredentialBindingTargetNotOuter({
        label: "credential binding replacement",
        targetScope: input.targetScope,
        sourceScope: input.sourceScope,
        sourceId: input.sourceId,
      });

      const source = yield* findSourceRowAtScope({
        pluginId: input.pluginId,
        sourceId: input.sourceId,
        sourceScope: input.sourceScope,
      });
      if (!source) {
        return yield* new StorageError({
          message:
            `Cannot replace credential bindings for source "${input.sourceId}" ` +
            `at scope "${input.sourceScope}": source is not visible.`,
          cause: undefined,
        });
      }

      const nextSlots = new Set(input.bindings.map((binding) => binding.slotKey));
      const existing = yield* core.findMany("credential_binding", {
        where: (b) =>
          b.and(
            b("scope_id", "=", input.targetScope),
            b("plugin_id", "=", input.pluginId),
            b("source_id", "=", input.sourceId),
            b("source_scope_id", "=", input.sourceScope),
          ),
      });
      for (const row of existing as readonly CredentialBindingRow[]) {
        const shouldOwnSlot = input.slotPrefixes.some((prefix) => row.slot_key.startsWith(prefix));
        if (shouldOwnSlot && !nextSlots.has(row.slot_key)) {
          yield* credentialBindingRemove({
            targetScope: input.targetScope,
            pluginId: input.pluginId,
            sourceId: input.sourceId,
            sourceScope: input.sourceScope,
            slotKey: row.slot_key,
          });
        }
      }

      const refs: CredentialBindingRef[] = [];
      for (const binding of input.bindings) {
        refs.push(
          yield* credentialBindingSet({
            targetScope: input.targetScope,
            pluginId: input.pluginId,
            sourceId: input.sourceId,
            sourceScope: input.sourceScope,
            slotKey: binding.slotKey,
            value: binding.value,
          }),
        );
      }
      return refs;
    });

  const credentialBindingRemoveForSource = (input: CredentialBindingSourceInput) =>
    Effect.gen(function* () {
      yield* assertScopeInStack("credential binding sourceScope", input.sourceScope);
      const source = yield* findSourceRowAtScope(input);
      if (!source) return;

      // Source-owner cleanup is intentionally broader than a normal scoped
      // binding delete. Removing a shared source must detach all credential
      // rows for that source identity, including user-owned bindings that
      // are not in the source owner's current stack.
      yield* core.deleteMany("credential_binding", {
        where: (b) =>
          b.and(
            b("plugin_id", "=", input.pluginId),
            b("source_id", "=", input.sourceId),
            b("source_scope_id", "=", input.sourceScope),
          ),
      });
    });

  const credentialBindingResolutionStatus = (
    row: CredentialBindingRow,
  ): Effect.Effect<"resolved" | "missing", StorageFailure> =>
    Effect.gen(function* () {
      if (row.kind === "text") return typeof row.text_value === "string" ? "resolved" : "missing";
      if (row.kind === "secret") {
        if (!row.secret_id) return "missing";
        const secret = yield* findSecretRowAtScope({
          secretId: row.secret_id,
          scopeId: row.secret_scope_id ?? row.scope_id,
        });
        if (!secret) return "missing";
        return (yield* secretRouteHasBackingValue(secret)) ? "resolved" : "missing";
      }
      if (row.kind === "connection") {
        if (!row.connection_id) return "missing";
        const connection = yield* findConnectionRowAtScope({
          connectionId: row.connection_id,
          scopeId: row.scope_id,
        });
        return connection ? "resolved" : "missing";
      }
      return "missing";
    });

  const credentialBindingResolve = (input: CredentialBindingSlotInput) =>
    Effect.gen(function* () {
      const rows = yield* credentialBindingRowsForSlot(input);
      const row = findInnermost(rows);
      if (!row) {
        return ResolvedCredentialSlot.make({
          pluginId: input.pluginId,
          sourceId: input.sourceId,
          sourceScopeId: input.sourceScope,
          slotKey: input.slotKey,
          bindingScopeId: null,
          kind: null,
          status: "missing" as const,
        });
      }
      return ResolvedCredentialSlot.make({
        pluginId: input.pluginId,
        sourceId: input.sourceId,
        sourceScopeId: input.sourceScope,
        slotKey: input.slotKey,
        bindingScopeId: ScopeId.make(row.scope_id),
        kind:
          row.kind === "text" || row.kind === "secret" || row.kind === "connection"
            ? row.kind
            : null,
        status: yield* credentialBindingResolutionStatus(row),
      });
    });

  const sourceNamesForCredentialBindings = (
    rows: readonly CredentialBindingRow[],
  ): Effect.Effect<Map<string, string>, StorageFailure> =>
    Effect.gen(function* () {
      const sourceIds = [...new Set(rows.map((row) => row.source_id))];
      if (sourceIds.length === 0) return new Map<string, string>();
      const sourceRows = yield* core.findMany("source", {
        where: scopedWhere(scopeIds, (b) => b("id", "in", sourceIds)),
      });
      return new Map(
        sourceRows.map((row) => [`${row.scope_id}\u0000${row.id}`, row.name] as const),
      );
    });

  const credentialBindingRowsToUsages = (
    rows: readonly CredentialBindingRow[],
  ): Effect.Effect<readonly Usage[], StorageFailure> =>
    Effect.gen(function* () {
      const names = yield* sourceNamesForCredentialBindings(rows);
      return rows.map((row) =>
        Usage.make({
          pluginId: row.plugin_id,
          scopeId: ScopeId.make(
            row.kind === "secret" ? (row.secret_scope_id ?? row.scope_id) : row.scope_id,
          ),
          ownerKind: "credential-binding",
          ownerId: row.source_id,
          ownerName: names.get(`${row.source_scope_id}\u0000${row.source_id}`) ?? null,
          slot: row.slot_key,
        }),
      );
    });

  const credentialBindingUsagesForSecret = (
    id: string,
  ): Effect.Effect<readonly Usage[], StorageFailure> =>
    Effect.gen(function* () {
      const rows = yield* core.findMany("credential_binding", {
        where: scopedWhere(scopeIds, (b) => b("secret_id", "=", id)),
      });
      return yield* credentialBindingRowsToUsages(rows as readonly CredentialBindingRow[]);
    });

  const credentialBindingUsagesForConnection = (
    id: string,
  ): Effect.Effect<readonly Usage[], StorageFailure> =>
    Effect.gen(function* () {
      const rows = yield* core.findMany("credential_binding", {
        where: scopedWhere(scopeIds, (b) => b("connection_id", "=", id)),
      });
      return yield* credentialBindingRowsToUsages(rows as readonly CredentialBindingRow[]);
    });

  const credentialBindings: CredentialBindingsFacade = {
    listForSource: credentialBindingListForSource,
    resolve: credentialBindingResolve,
    set: credentialBindingSet,
    remove: credentialBindingRemove,
    replaceForSource: credentialBindingReplaceForSource,
    removeForSource: credentialBindingRemoveForSource,
    usagesForSecret: credentialBindingUsagesForSecret,
    usagesForConnection: credentialBindingUsagesForConnection,
  };

  return credentialBindings;
};

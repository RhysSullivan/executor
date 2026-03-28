import {
  createHash,
} from "node:crypto";

import type {
  CreatePolicyPayload,
  UpdatePolicyPayload,
} from "./contracts";
import {
  PolicyIdSchema,
  type LocalExecutorConfig,
  type LocalScopePolicy,
  type PolicyId,
  type ScopeId,
} from "../schema";
import * as Effect from "effect/Effect";

import {
  requireRuntimeLocalScope,
} from "../runtime/scope/runtime-context";
import type {
  ScopeConfigStoreShape,
  ScopeStateStoreShape,
} from "../runtime/scope/storage";
import {
  ScopeConfigStore,
  ScopeStateStore,
} from "../runtime/scope/storage";
import {
  type LocalScopeState,
} from "../runtime/scope-state";
import {
  derivePolicyConfigKey,
} from "../runtime/scope/scope-sync";
import {
  type OperationErrors,
  operationErrors,
} from "../runtime/policy/operation-errors";

const policyOps = {
  list: operationErrors("policies.list"),
  create: operationErrors("policies.create"),
  get: operationErrors("policies.get"),
  update: operationErrors("policies.update"),
  remove: operationErrors("policies.remove"),
} as const;

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const scopePolicyStableKey = (input: {
  scopeId: ScopeId;
  scopeRoot?: string | null;
}): string => input.scopeRoot?.trim() || input.scopeId;

const localPolicyIdForKey = (input: {
  scopeStableKey: string;
  key: string;
}): PolicyId =>
  PolicyIdSchema.make(
    `pol_local_${createHash("sha256").update(`${input.scopeStableKey}:${input.key}`).digest("hex").slice(0, 16)}`,
  );

const toLocalScopePolicy = (input: {
  scopeId: ScopeId;
  scopeStableKey: string;
  key: string;
  policyConfig: NonNullable<LocalExecutorConfig["policies"]>[string];
  state: LocalScopeState["policies"][string] | undefined;
}): LocalScopePolicy => ({
  id:
    input.state?.id ??
    localPolicyIdForKey({
      scopeStableKey: input.scopeStableKey,
      key: input.key,
    }),
  key: input.key,
  scopeId: input.scopeId,
  resourcePattern: input.policyConfig.match.trim(),
  effect: input.policyConfig.action,
  approvalMode: input.policyConfig.approval === "manual" ? "required" : "auto",
  priority: input.policyConfig.priority ?? 0,
  enabled: input.policyConfig.enabled ?? true,
  createdAt: input.state?.createdAt ?? Date.now(),
  updatedAt: input.state?.updatedAt ?? Date.now(),
});

export const loadRuntimeLocalScopePolicies = (scopeId: ScopeId) =>
  Effect.gen(function* () {
    const runtimeLocalScope =
      yield* requireRuntimeLocalScope(scopeId);
    const scopeConfigStore = yield* ScopeConfigStore;
    const scopeStateStore = yield* ScopeStateStore;
    const loadedConfig = yield* scopeConfigStore.load();
    const scopeState = yield* scopeStateStore.load();

    const policies = Object.entries(loadedConfig.config?.policies ?? {}).map(
      ([key, policyConfig]) =>
        toLocalScopePolicy({
          scopeId,
          scopeStableKey: scopePolicyStableKey({
            scopeId,
            scopeRoot: runtimeLocalScope.scope.scopeRoot,
          }),
          key,
          policyConfig,
          state: scopeState.policies[key],
        }),
    );

    return {
      runtimeLocalScope,
      loadedConfig,
      scopeState,
      policies,
    };
  });

const writeLocalPolicyFiles = (input: {
  operation: OperationErrors;
  scopeConfigStore: ScopeConfigStoreShape;
  scopeStateStore: ScopeStateStoreShape;
  projectConfig: LocalExecutorConfig;
  scopeState: LocalScopeState;
}) =>
  Effect.all(
    [
      input.scopeConfigStore.writeProject({
        config: input.projectConfig,
      }),
      input.scopeStateStore.write({
        state: input.scopeState,
      }),
    ],
    { discard: true },
  ).pipe(
    Effect.mapError((cause) =>
      input.operation.unknownStorage(
        cause,
        "Failed writing local scope policy files",
      ),
    ),
  );

const loadScopePolicyContext = (
  operation: OperationErrors,
  scopeId: ScopeId,
) =>
  requireRuntimeLocalScope(scopeId).pipe(
    Effect.mapError((cause) =>
      operation.notFound(
        "Workspace not found",
        cause instanceof Error ? cause.message : String(cause),
      ),
    ),
  );

export const listPolicies = (scopeId: ScopeId) =>
  Effect.gen(function* () {
    yield* loadScopePolicyContext(policyOps.list, scopeId);
    const localScope = yield* loadRuntimeLocalScopePolicies(
      scopeId,
    ).pipe(
      Effect.mapError((cause) =>
        policyOps.list.unknownStorage(
          cause,
          "Failed loading local scope policies",
        ),
      ),
    );
    return localScope.policies;
  });

export const createPolicy = (input: {
  scopeId: ScopeId;
  payload: CreatePolicyPayload;
}) =>
  Effect.gen(function* () {
    const runtimeLocalScope = yield* loadScopePolicyContext(
      policyOps.create,
      input.scopeId,
    );
    const scopeConfigStore = yield* ScopeConfigStore;
    const scopeStateStore = yield* ScopeStateStore;
    const localScope = yield* loadRuntimeLocalScopePolicies(
      input.scopeId,
    ).pipe(
      Effect.mapError((cause) =>
        policyOps.create.unknownStorage(
          cause,
          "Failed loading local scope policies",
        ),
      ),
    );
    const now = Date.now();
    const projectConfig = cloneJson(
      localScope.loadedConfig.projectConfig ?? {},
    );
    const policies = { ...projectConfig.policies };
    const key = derivePolicyConfigKey(
      {
        resourcePattern: input.payload.resourcePattern ?? "*",
        effect: input.payload.effect ?? "allow",
        approvalMode: input.payload.approvalMode ?? "auto",
      },
      new Set(Object.keys(policies)),
    );

    policies[key] = {
      match: input.payload.resourcePattern ?? "*",
      action: input.payload.effect ?? "allow",
      approval:
        (input.payload.approvalMode ?? "auto") === "required"
          ? "manual"
          : "auto",
      ...(input.payload.enabled === false ? { enabled: false } : {}),
      ...((input.payload.priority ?? 0) !== 0
        ? { priority: input.payload.priority ?? 0 }
        : {}),
    };

    const existingState = localScope.scopeState.policies[key];
    const scopeState: LocalScopeState = {
      ...localScope.scopeState,
      policies: {
        ...localScope.scopeState.policies,
        [key]: {
          id:
            existingState?.id ??
            localPolicyIdForKey({
              scopeStableKey: scopePolicyStableKey({
                scopeId: input.scopeId,
                scopeRoot: runtimeLocalScope.scope.scopeRoot,
              }),
              key,
            }),
          createdAt: existingState?.createdAt ?? now,
          updatedAt: now,
        },
      },
    };

    yield* writeLocalPolicyFiles({
      operation: policyOps.create,
      scopeConfigStore,
      scopeStateStore,
      projectConfig: {
        ...projectConfig,
        policies,
      },
      scopeState,
    });

    return toLocalScopePolicy({
      scopeId: input.scopeId,
      scopeStableKey: scopePolicyStableKey({
        scopeId: input.scopeId,
        scopeRoot: runtimeLocalScope.scope.scopeRoot,
      }),
      key,
      policyConfig: policies[key]!,
      state: scopeState.policies[key],
    });
  });

export const getPolicy = (input: {
  scopeId: ScopeId;
  policyId: PolicyId;
}) =>
  Effect.gen(function* () {
    yield* loadScopePolicyContext(policyOps.get, input.scopeId);
    const localScope = yield* loadRuntimeLocalScopePolicies(
      input.scopeId,
    ).pipe(
      Effect.mapError((cause) =>
        policyOps.get.unknownStorage(
          cause,
          "Failed loading local scope policies",
        ),
      ),
    );
    const policy =
      localScope.policies.find(
        (candidate) => candidate.id === input.policyId,
      ) ?? null;
    if (policy === null) {
      return yield* policyOps.get.notFound(
        "Policy not found",
        `scopeId=${input.scopeId} policyId=${input.policyId}`,
      );
    }
    return policy;
  });

export const updatePolicy = (input: {
  scopeId: ScopeId;
  policyId: PolicyId;
  payload: UpdatePolicyPayload;
}) =>
  Effect.gen(function* () {
    const runtimeLocalScope = yield* loadScopePolicyContext(
      policyOps.update,
      input.scopeId,
    );
    const scopeConfigStore = yield* ScopeConfigStore;
    const scopeStateStore = yield* ScopeStateStore;
    const localScope = yield* loadRuntimeLocalScopePolicies(
      input.scopeId,
    ).pipe(
      Effect.mapError((cause) =>
        policyOps.update.unknownStorage(
          cause,
          "Failed loading local scope policies",
        ),
      ),
    );
    const existing =
      localScope.policies.find(
        (candidate) => candidate.id === input.policyId,
      ) ?? null;
    if (existing === null) {
      return yield* policyOps.update.notFound(
        "Policy not found",
        `scopeId=${input.scopeId} policyId=${input.policyId}`,
      );
    }

    const projectConfig = cloneJson(
      localScope.loadedConfig.projectConfig ?? {},
    );
    const policies = { ...projectConfig.policies };
    const existingConfig = policies[existing.key]!;

    policies[existing.key] = {
      ...existingConfig,
      ...(input.payload.resourcePattern !== undefined
        ? { match: input.payload.resourcePattern }
        : {}),
      ...(input.payload.effect !== undefined
        ? { action: input.payload.effect }
        : {}),
      ...(input.payload.approvalMode !== undefined
        ? {
            approval:
              input.payload.approvalMode === "required" ? "manual" : "auto",
          }
        : {}),
      ...(input.payload.enabled !== undefined
        ? { enabled: input.payload.enabled }
        : {}),
      ...(input.payload.priority !== undefined
        ? { priority: input.payload.priority }
        : {}),
    };

    const updatedAt = Date.now();
    const existingState = localScope.scopeState.policies[existing.key];
    const scopeState: LocalScopeState = {
      ...localScope.scopeState,
      policies: {
        ...localScope.scopeState.policies,
        [existing.key]: {
          id: existing.id,
          createdAt: existingState?.createdAt ?? existing.createdAt,
          updatedAt,
        },
      },
    };

    yield* writeLocalPolicyFiles({
      operation: policyOps.update,
      scopeConfigStore,
      scopeStateStore,
      projectConfig: {
        ...projectConfig,
        policies,
      },
      scopeState,
    });

    return toLocalScopePolicy({
      scopeId: input.scopeId,
      scopeStableKey: scopePolicyStableKey({
        scopeId: input.scopeId,
        scopeRoot: runtimeLocalScope.scope.scopeRoot,
      }),
      key: existing.key,
      policyConfig: policies[existing.key]!,
      state: scopeState.policies[existing.key],
    });
  });

export const removePolicy = (input: {
  scopeId: ScopeId;
  policyId: PolicyId;
}) =>
  Effect.gen(function* () {
    yield* loadScopePolicyContext(
      policyOps.remove,
      input.scopeId,
    );
    const scopeConfigStore = yield* ScopeConfigStore;
    const scopeStateStore = yield* ScopeStateStore;
    const localScope = yield* loadRuntimeLocalScopePolicies(
      input.scopeId,
    ).pipe(
      Effect.mapError((cause) =>
        policyOps.remove.unknownStorage(
          cause,
          "Failed loading local scope policies",
        ),
      ),
    );
    const existing =
      localScope.policies.find(
        (candidate) => candidate.id === input.policyId,
      ) ?? null;
    if (existing === null) {
      return { removed: false };
    }

    const projectConfig = cloneJson(
      localScope.loadedConfig.projectConfig ?? {},
    );
    const policies = { ...projectConfig.policies };
    delete policies[existing.key];

    const { [existing.key]: _removedPolicy, ...remainingPolicies } =
      localScope.scopeState.policies;
    yield* writeLocalPolicyFiles({
      operation: policyOps.remove,
      scopeConfigStore,
      scopeStateStore,
      projectConfig: {
        ...projectConfig,
        policies,
      },
      scopeState: {
        ...localScope.scopeState,
        policies: remainingPolicies,
      },
    });

    return { removed: true };
  });

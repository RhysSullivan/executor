import { Atom, Result } from "@effect-atom/atom";
import type * as Registry from "@effect-atom/atom/Registry";
import { RegistryContext, RegistryProvider, useAtomValue } from "@effect-atom/atom-react";
import {
  createExecutorApiClient,
  type ExecutorApiClient,
} from "@executor/platform-api/client";
import type {
  CreateSecretPayload,
  CreateSecretResult,
  CreateSourcePayload,
  CreateWorkspaceOauthClientPayload,
  DeleteSecretResult,
  DiscoverSourcePayload,
  InstanceConfig,
  LocalInstallation,
  SecretListItem,
  UpdateSecretPayload,
  UpdateSecretResult,
  UpdateSourcePayload,
} from "@executor/platform-api";
import type {
  Source,
  SourceDiscoveryResult,
  SourceInspection,
  SourceInspectionDiscoverResult,
  SourceInspectionToolDetail,
  ScopeOauthClient as WorkspaceOauthClient,
} from "@executor/platform-sdk/schema";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as React from "react";

const DEFAULT_EXECUTOR_API_BASE_URL = "http://127.0.0.1:8788";
const PLACEHOLDER_WORKSPACE_ID = "ws_placeholder" as Source["scopeId"];
const PLACEHOLDER_ACCOUNT_ID = "acc_placeholder";
const PLACEHOLDER_SOURCE_ID = "src_placeholder" as Source["id"];

type SourceMutationState<T> = {
  status: "idle" | "pending" | "success" | "error";
  data: T | null;
  error: Error | null;
};

export type SourceRemoveResult = {
  removed: boolean;
};

type AtomKeyPart = string | number | boolean | null | undefined;

type SourcesKeyParts = readonly [boolean, Source["scopeId"], string];
type SourceKeyParts = readonly [boolean, Source["scopeId"], string, Source["id"]];
type SourceToolDetailKeyParts = readonly [
  boolean,
  Source["scopeId"],
  string,
  Source["id"],
  string | null,
];
type SourceDiscoveryKeyParts = readonly [
  boolean,
  Source["scopeId"],
  string,
  Source["id"],
  string,
  number | null,
];
type WorkspaceOauthClientsKeyParts = readonly [
  boolean,
  Source["scopeId"],
  string,
  string,
];

type InvalidationTarget = {
  workspaceId?: Source["scopeId"];
  accountId?: string;
  sourceId?: Source["id"];
};

type ActiveQueryCollections = {
  sourceLists: Set<string>;
  sources: Set<string>;
  workspaceOauthClients: Set<string>;
  inspections: Set<string>;
  toolDetails: Set<string>;
  discoveries: Set<string>;
};

type ExecutorQueryContextValue = {
  registry: Registry.Registry;
  activeQueries: ActiveQueryCollections;
  invalidateQueries: (target?: InvalidationTarget) => void;
};

type MutationExecutionContext = {
  workspaceId: Source["scopeId"];
  accountId: string;
  registry: Registry.Registry;
  invalidateQueries: (target?: InvalidationTarget) => void;
};

type OptimisticMutationResult<T> =
  | void
  | (() => void)
  | {
      rollback?: () => void;
      value?: T;
    };

type MutationOptions<TInput, TOutput, TOptimistic = never> = {
  optimisticUpdate?: (
    context: MutationExecutionContext,
    payload: TInput,
  ) => OptimisticMutationResult<TOptimistic>;
  onSuccess?: (
    context: MutationExecutionContext,
    payload: TInput,
    data: TOutput,
    optimisticValue: TOptimistic | undefined,
  ) => void;
};

type InternalNode<A> = {
  setValue: (value: A) => void;
  valueOption?: () => Option.Option<A>;
};

let apiBaseUrl =
  typeof window !== "undefined" && typeof window.location?.origin === "string"
    ? window.location.origin
    : DEFAULT_EXECUTOR_API_BASE_URL;

const ExecutorQueryContext = React.createContext<ExecutorQueryContextValue | null>(null);

const encodeAtomKey = (parts: ReadonlyArray<AtomKeyPart>): string => JSON.stringify(parts);

const decodeAtomKey = <T extends ReadonlyArray<AtomKeyPart>>(key: string): T => JSON.parse(key) as T;

const encodeSourcesKey = (
  enabled: boolean,
  workspaceId: Source["scopeId"],
  accountId: string,
): string => encodeAtomKey([enabled, workspaceId, accountId] satisfies SourcesKeyParts);

const encodeSourceKey = (
  enabled: boolean,
  workspaceId: Source["scopeId"],
  accountId: string,
  sourceId: Source["id"],
): string => encodeAtomKey([enabled, workspaceId, accountId, sourceId] satisfies SourceKeyParts);

const encodeToolDetailKey = (
  enabled: boolean,
  workspaceId: Source["scopeId"],
  accountId: string,
  sourceId: Source["id"],
  toolPath: string | null,
): string =>
  encodeAtomKey([enabled, workspaceId, accountId, sourceId, toolPath] satisfies SourceToolDetailKeyParts);

const encodeDiscoveryKey = (
  enabled: boolean,
  workspaceId: Source["scopeId"],
  accountId: string,
  sourceId: Source["id"],
  query: string,
  limit: number | null,
): string =>
  encodeAtomKey([enabled, workspaceId, accountId, sourceId, query, limit] satisfies SourceDiscoveryKeyParts);

const encodeWorkspaceOauthClientsKey = (
  enabled: boolean,
  workspaceId: Source["scopeId"],
  accountId: string,
  providerKey: string,
): string =>
  encodeAtomKey(
    [enabled, workspaceId, accountId, providerKey] satisfies WorkspaceOauthClientsKeyParts,
  );

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const causeMessage = (cause: Cause.Cause<unknown>): Error =>
  new Error(Cause.pretty(cause));

const shouldLogExecutorDevErrors = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  const hostname = window.location.hostname;
  return hostname === "localhost" || hostname === "127.0.0.1";
};

const describeExecutorDevError = (cause: unknown): Record<string, unknown> => {
  if (Runtime.isFiberFailure(cause)) {
    const inner = cause[Runtime.FiberFailureCauseId];
    return {
      name: cause.name,
      message: cause.message,
      cause: Cause.pretty(inner),
    };
  }

  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      stack: cause.stack,
    };
  }

  return {
    message: String(cause),
  };
};

const logExecutorDevError = (label: string, details: Record<string, unknown>): void => {
  if (!shouldLogExecutorDevErrors()) {
    return;
  }

  console.error(`[executor react] ${label}`, details);
};

const runControlPlane = async <A>(input: {
  baseUrl?: string;
  accountId?: string;
  execute: (client: ExecutorApiClient) => Promise<A>;
}): Promise<A> => {
  const baseUrl = input.baseUrl ?? apiBaseUrl;
  const accountId = input.accountId;

  try {
    const client = await createExecutorApiClient({
      baseUrl,
      ...(accountId !== undefined ? { accountId } : {}),
    });
    return await input.execute(client);
  } catch (cause) {
    const error = toError(cause);
    logExecutorDevError("control-plane request failed", {
      baseUrl,
      accountId,
      error: describeExecutorDevError(error),
    });
    throw error;
  }
};

const controlPlaneRequest = <A>(input: {
  baseUrl?: string;
  accountId?: string;
  execute: (client: ExecutorApiClient) => Promise<A>;
}): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: () => runControlPlane(input),
    catch: toError,
  });

const localInstallationAtom = Atom.family((baseUrl: string) =>
  Atom.make(
    controlPlaneRequest({
      baseUrl,
      execute: (client) => client.local.installation({}),
    }),
  ).pipe(Atom.keepAlive),
);

const instanceConfigAtom = Atom.family((baseUrl: string) =>
  Atom.make(
    controlPlaneRequest({
      baseUrl,
      execute: (client) => client.local.config({}),
    }),
  ).pipe(Atom.keepAlive),
);

const secretsAtom = Atom.family((baseUrl: string) =>
  Atom.make(
    controlPlaneRequest({
      baseUrl,
      execute: (client) => client.local.listSecrets({}),
    }),
  ).pipe(Atom.keepAlive),
);

const sourcesAtom = Atom.family((key: string) => {
  const [enabled, workspaceId, accountId] = decodeAtomKey<SourcesKeyParts>(key);

  return Atom.make(
    enabled
      ? controlPlaneRequest({
            accountId,
            execute: (client) => client.sources.list({
              path: {
                workspaceId,
              },
            }),
          })
      : Effect.never,
  ).pipe(Atom.keepAlive);
});

const sourceAtom = Atom.family((key: string) => {
  const [enabled, workspaceId, accountId, sourceId] = decodeAtomKey<SourceKeyParts>(key);

  return Atom.make(
    enabled
      ? controlPlaneRequest({
            accountId,
            execute: (client) => client.sources.get({
              path: {
                workspaceId,
                sourceId,
              },
            }),
          })
      : Effect.never,
  ).pipe(Atom.keepAlive);
});

const sourceInspectionAtom = Atom.family((key: string) => {
  const [enabled, workspaceId, accountId, sourceId] = decodeAtomKey<SourceKeyParts>(key);

  return Atom.make(
    enabled
      ? controlPlaneRequest({
            accountId,
            execute: (client) => client.sources.inspection({
              path: {
                workspaceId,
                sourceId,
              },
            }),
          })
      : Effect.never,
  ).pipe(Atom.keepAlive);
});

const sourceInspectionToolAtom = Atom.family((key: string) => {
  const [enabled, workspaceId, accountId, sourceId, toolPath] = decodeAtomKey<SourceToolDetailKeyParts>(key);

  return Atom.make(
    enabled && toolPath
      ? controlPlaneRequest({
            accountId,
            execute: (client) => client.sources.inspectionTool({
              path: {
                workspaceId,
                sourceId,
                toolPath,
              },
            }),
          })
      : Effect.succeed<SourceInspectionToolDetail | null>(null),
  ).pipe(Atom.keepAlive);
});

const sourceDiscoveryAtom = Atom.family((key: string) => {
  const [enabled, workspaceId, accountId, sourceId, query, limit] = decodeAtomKey<SourceDiscoveryKeyParts>(key);

  return Atom.make(
    !enabled
      ? Effect.never
      : query.trim().length === 0
        ? Effect.succeed<SourceInspectionDiscoverResult>({
            query: "",
            queryTokens: [],
            bestPath: null,
            total: 0,
            results: [],
          })
        : controlPlaneRequest({
              accountId,
              execute: (client) => client.sources.inspectionDiscover({
                path: {
                  workspaceId,
                  sourceId,
                },
                payload: {
                  query,
                  ...(limit !== null ? { limit } : {}),
                },
              }),
            }),
  ).pipe(Atom.keepAlive);
});

const workspaceOauthClientsAtom = Atom.family((key: string) => {
  const [enabled, workspaceId, accountId, providerKey] = decodeAtomKey<WorkspaceOauthClientsKeyParts>(key);

  return Atom.make(
    enabled
      ? controlPlaneRequest({
          accountId,
          execute: (client) => client.sources.listWorkspaceOauthClients({
            path: {
              workspaceId,
            },
            urlParams: {
              providerKey,
            },
          }),
        })
      : Effect.never,
  ).pipe(Atom.keepAlive);
});

export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; data: T };

type WorkspaceContext = {
  installation: LocalInstallation;
  workspaceId: Source["scopeId"];
  accountId: string;
};

const toLoadable = <T>(result: Result.Result<T, Error>): Loadable<T> => {
  if (Result.isSuccess(result)) {
    return {
      status: "ready",
      data: result.value,
    };
  }

  if (Result.isFailure(result)) {
    return {
      status: "error",
      error: causeMessage(result.cause),
    };
  }

  return {
    status: "loading",
  };
};

const pendingLoadable = <T>(workspace: Loadable<WorkspaceContext>): Loadable<T> => {
  if (workspace.status === "loading") {
    return { status: "loading" };
  }

  if (workspace.status === "error") {
    return { status: "error", error: workspace.error };
  }

  throw new Error("Expected workspace loadable to be pending or errored");
};

const useLoadableAtom = <T>(atom: Atom.Atom<Result.Result<T, Error>>): Loadable<T> => {
  const result = useAtomValue(atom);
  return React.useMemo(() => toLoadable(result), [result]);
};

const useWorkspaceContext = (): Loadable<WorkspaceContext> => {
  const installation = useLoadableAtom(localInstallationAtom(apiBaseUrl));

  return React.useMemo(() => {
    if (installation.status !== "ready") {
      return installation;
    }

    return {
      status: "ready",
      data: {
        installation: installation.data,
        workspaceId: installation.data.scopeId,
        accountId: installation.data.actorScopeId,
      },
    } satisfies Loadable<WorkspaceContext>;
  }, [installation]);
};

const useWorkspaceRequestContext = () => {
  const workspace = useWorkspaceContext();
  const enabled = workspace.status === "ready";

  const workspaceId = enabled
    ? workspace.data.workspaceId
    : PLACEHOLDER_WORKSPACE_ID;
  const accountId = enabled
    ? workspace.data.accountId
    : PLACEHOLDER_ACCOUNT_ID;

  return React.useMemo(
    () => ({
      workspace,
      enabled,
      workspaceId,
      accountId,
    }),
    [accountId, enabled, workspace, workspaceId],
  );
};

const getCachedAtomValue = <A>(
  registry: Registry.Registry,
  atom: Atom.Atom<Result.Result<A, Error>>,
): A | undefined => {
  const node = (registry.getNodes().get(atom) ?? null) as InternalNode<Result.Result<A, Error>> | null;
  if (node === null || typeof node.valueOption !== "function") {
    return undefined;
  }

  const option = node.valueOption();
  if (Option.isNone(option)) {
    return undefined;
  }

  if (!Result.isSuccess(option.value)) {
    return undefined;
  }

  return option.value.value;
};

const setCachedAtomValue = <A>(
  registry: Registry.Registry,
  atom: Atom.Atom<Result.Result<A, Error>>,
  value: A,
): void => {
  const ensureNode = (registry as {
    ensureNode?: (atom: Atom.Atom<Result.Result<A, Error>>) => InternalNode<Result.Result<A, Error>>;
  }).ensureNode;
  if (typeof ensureNode !== "function") {
    return;
  }

  ensureNode.call(registry, atom).setValue(Result.success(value));
};

const createActiveQueryCollections = (): ActiveQueryCollections => ({
  sourceLists: new Set(),
  sources: new Set(),
  workspaceOauthClients: new Set(),
  inspections: new Set(),
  toolDetails: new Set(),
  discoveries: new Set(),
});

const targetMatches = (
  target: InvalidationTarget | undefined,
  workspaceId: Source["scopeId"],
  accountId: string,
  sourceId?: Source["id"],
): boolean => {
  if (target?.workspaceId !== undefined && target.workspaceId !== workspaceId) {
    return false;
  }
  if (target?.accountId !== undefined && target.accountId !== accountId) {
    return false;
  }
  if (target?.sourceId !== undefined && target.sourceId !== sourceId) {
    return false;
  }
  return true;
};

const invalidateTrackedQueries = (
  registry: Registry.Registry,
  activeQueries: ActiveQueryCollections,
  target?: InvalidationTarget,
): void => {
  activeQueries.sourceLists.forEach((key) => {
    const [enabled, workspaceId, accountId] = decodeAtomKey<SourcesKeyParts>(key);
    if (enabled && targetMatches(target, workspaceId, accountId)) {
      registry.refresh(sourcesAtom(key));
    }
  });

  activeQueries.sources.forEach((key) => {
    const [enabled, workspaceId, accountId, sourceId] = decodeAtomKey<SourceKeyParts>(key);
    if (enabled && targetMatches(target, workspaceId, accountId, sourceId)) {
      registry.refresh(sourceAtom(key));
    }
  });

  activeQueries.workspaceOauthClients.forEach((key) => {
    const [enabled, workspaceId, accountId] = decodeAtomKey<WorkspaceOauthClientsKeyParts>(key);
    if (enabled && targetMatches(target, workspaceId, accountId)) {
      registry.refresh(workspaceOauthClientsAtom(key));
    }
  });

  activeQueries.inspections.forEach((key) => {
    const [enabled, workspaceId, accountId, sourceId] = decodeAtomKey<SourceKeyParts>(key);
    if (enabled && targetMatches(target, workspaceId, accountId, sourceId)) {
      registry.refresh(sourceInspectionAtom(key));
    }
  });

  activeQueries.toolDetails.forEach((key) => {
    const [enabled, workspaceId, accountId, sourceId] = decodeAtomKey<SourceToolDetailKeyParts>(key);
    if (enabled && targetMatches(target, workspaceId, accountId, sourceId)) {
      registry.refresh(sourceInspectionToolAtom(key));
    }
  });

  activeQueries.discoveries.forEach((key) => {
    const [enabled, workspaceId, accountId, sourceId] = decodeAtomKey<SourceDiscoveryKeyParts>(key);
    if (enabled && targetMatches(target, workspaceId, accountId, sourceId)) {
      registry.refresh(sourceDiscoveryAtom(key));
    }
  });
};

const useExecutorQueryContext = (): ExecutorQueryContextValue => {
  const context = React.useContext(ExecutorQueryContext);
  if (context === null) {
    throw new Error("ExecutorReactProvider is missing from the React tree");
  }
  return context;
};

const useTrackActiveKey = (
  collection: keyof ActiveQueryCollections,
  key: string,
  enabled: boolean,
): void => {
  const { activeQueries } = useExecutorQueryContext();

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    const bucket = activeQueries[collection];
    bucket.add(key);
    return () => {
      bucket.delete(key);
    };
  }, [activeQueries, collection, enabled, key]);
};

const upsertSourceInList = (
  sources: ReadonlyArray<Source>,
  nextSource: Source,
): ReadonlyArray<Source> => {
  const index = sources.findIndex((source) => source.id === nextSource.id);
  if (index === -1) {
    return [nextSource, ...sources];
  }

  const next = sources.slice();
  next[index] = nextSource;
  return next;
};

const removeSourceFromList = (
  sources: ReadonlyArray<Source>,
  sourceId: Source["id"],
): ReadonlyArray<Source> => sources.filter((source) => source.id !== sourceId);

const createOptimisticSource = (input: {
  workspaceId: Source["scopeId"];
  payload: CreateSourcePayload;
}): Source => {
  const now = Date.now();

  return {
    id: `src_optimistic_${crypto.randomUUID()}` as Source["id"],
    scopeId: input.workspaceId,
    name: input.payload.name,
    kind: input.payload.kind,
    endpoint: input.payload.endpoint,
    status: input.payload.status ?? "draft",
    enabled: input.payload.enabled ?? true,
    namespace: input.payload.namespace ?? null,
    bindingVersion: 1,
    binding: input.payload.binding ?? {},
    importAuthPolicy: input.payload.importAuthPolicy ?? "reuse_runtime",
    importAuth: input.payload.importAuth ?? { kind: "none" },
    auth: input.payload.auth ?? { kind: "none" },
    sourceHash: input.payload.sourceHash ?? null,
    lastError: input.payload.lastError ?? null,
    createdAt: now,
    updatedAt: now,
  };
};

const applyUpdatePayloadToSource = (source: Source, payload: UpdateSourcePayload): Source => ({
  ...source,
  name: payload.name ?? source.name,
  endpoint: payload.endpoint ?? source.endpoint,
  status: payload.status ?? source.status,
  enabled: payload.enabled ?? source.enabled,
  namespace: payload.namespace !== undefined ? payload.namespace : source.namespace,
  binding: payload.binding !== undefined ? payload.binding : source.binding,
  auth: payload.auth !== undefined ? payload.auth : source.auth,
  sourceHash: payload.sourceHash !== undefined ? payload.sourceHash : source.sourceHash,
  lastError: payload.lastError !== undefined ? payload.lastError : source.lastError,
  updatedAt: Date.now(),
});

const useSourceMutation = <TInput, TOutput, TOptimistic = never>(
  execute: (input: {
    workspaceId: Source["scopeId"];
    accountId: string;
    payload: TInput;
  }) => Promise<TOutput>,
  options?: MutationOptions<TInput, TOutput, TOptimistic>,
) => {
  const workspace = useWorkspaceRequestContext();
  const { registry, invalidateQueries } = useExecutorQueryContext();
  const [state, setState] = React.useState<SourceMutationState<TOutput>>({
    status: "idle",
    data: null,
    error: null,
  });

  const mutateAsync = React.useCallback(async (payload: TInput) => {
    if (!workspace.enabled) {
      const error = new Error("Executor workspace context is not ready");
      setState({ status: "error", data: null, error });
      throw error;
    }

    const executionContext: MutationExecutionContext = {
      workspaceId: workspace.workspaceId,
      accountId: workspace.accountId,
      registry,
      invalidateQueries,
    };

    setState((current) => ({
      status: "pending",
      data: current.data,
      error: null,
    }));

    const optimistic = options?.optimisticUpdate?.(executionContext, payload);
    const rollback = typeof optimistic === "function"
      ? optimistic
      : optimistic?.rollback;
    const optimisticValue = typeof optimistic === "function"
      ? undefined
      : optimistic?.value;

    try {
      const data = await execute({
        workspaceId: workspace.workspaceId,
        accountId: workspace.accountId,
        payload,
      });
      options?.onSuccess?.(executionContext, payload, data, optimisticValue);
      setState({ status: "success", data, error: null });
      return data;
    } catch (cause) {
      rollback?.();
      logExecutorDevError("source mutation failed", {
        workspaceId: workspace.workspaceId,
        accountId: workspace.accountId,
        payload,
        error: describeExecutorDevError(cause),
        cause,
      });
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setState({ status: "error", data: null, error });
      throw error;
    }
  }, [execute, invalidateQueries, options, registry, workspace.accountId, workspace.enabled, workspace.workspaceId]);

  const reset = React.useCallback(() => {
    setState({ status: "idle", data: null, error: null });
  }, []);

  return React.useMemo(
    () => ({
      ...state,
      mutateAsync,
      reset,
    }),
    [mutateAsync, reset, state],
  );
};

const ExecutorReactProviderInner = (props: React.PropsWithChildren) => {
  const registry = React.useContext(RegistryContext);
  const activeQueries = React.useMemo(createActiveQueryCollections, []);
  const invalidateQueries = React.useCallback((target?: InvalidationTarget) => {
    invalidateTrackedQueries(registry, activeQueries, target);
  }, [activeQueries, registry]);

  const value = React.useMemo<ExecutorQueryContextValue>(() => ({
    registry,
    activeQueries,
    invalidateQueries,
  }), [activeQueries, invalidateQueries, registry]);

  return React.createElement(ExecutorQueryContext.Provider, { value }, props.children);
};

export const setExecutorApiBaseUrl = (baseUrl: string): void => {
  apiBaseUrl = baseUrl;
};

export const ExecutorReactProvider = (props: React.PropsWithChildren) =>
  React.createElement(
    RegistryProvider,
    null,
    React.createElement(ExecutorReactProviderInner, null, props.children),
  );

export const useInvalidateExecutorQueries = (): (() => void) => {
  const { invalidateQueries } = useExecutorQueryContext();
  return React.useCallback(() => {
    invalidateQueries();
  }, [invalidateQueries]);
};

export const useLocalInstallation = (): Loadable<LocalInstallation> =>
  useLoadableAtom(localInstallationAtom(apiBaseUrl));

export const useInstanceConfig = (): Loadable<InstanceConfig> =>
  useLoadableAtom(instanceConfigAtom(apiBaseUrl));

export const useSecrets = (): Loadable<ReadonlyArray<SecretListItem>> =>
  useLoadableAtom(secretsAtom(apiBaseUrl));

export const useRefreshSecrets = (): (() => void) => {
  const registry = React.useContext(RegistryContext);
  return React.useCallback(() => {
    registry.refresh(secretsAtom(apiBaseUrl));
  }, [registry]);
};

type SecretMutationState<T> = {
  status: "idle" | "pending" | "success" | "error";
  data: T | null;
  error: Error | null;
};

const useSecretMutation = <TInput, TOutput>(
  execute: (input: TInput) => Promise<TOutput>,
) => {
  const registry = React.useContext(RegistryContext);
  const [state, setState] = React.useState<SecretMutationState<TOutput>>({
    status: "idle",
    data: null,
    error: null,
  });

  const mutateAsync = React.useCallback(async (payload: TInput) => {
    setState((current) => ({
      status: "pending",
      data: current.data,
      error: null,
    }));

    try {
      const data = await execute(payload);
      registry.refresh(secretsAtom(apiBaseUrl));
      setState({ status: "success", data, error: null });
      return data;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setState({ status: "error", data: null, error });
      throw error;
    }
  }, [execute, registry]);

  const reset = React.useCallback(() => {
    setState({ status: "idle", data: null, error: null });
  }, []);

  return React.useMemo(
    () => ({
      ...state,
      mutateAsync,
      reset,
    }),
    [mutateAsync, reset, state],
  );
};

export const useCreateSecret = () =>
  useSecretMutation<CreateSecretPayload, CreateSecretResult>(
    React.useCallback(
      (payload) =>
        runControlPlane({
          execute: (client) => client.local.createSecret({
            payload,
          }),
        }),
      [],
    ),
  );

export const useUpdateSecret = () =>
  useSecretMutation<{ secretId: string; payload: UpdateSecretPayload }, UpdateSecretResult>(
    React.useCallback(
      (input) =>
        runControlPlane({
          execute: (client) => client.local.updateSecret({
            path: { secretId: input.secretId },
            payload: input.payload,
          }),
        }),
      [],
    ),
  );

export const useDeleteSecret = () =>
  useSecretMutation<string, DeleteSecretResult>(
    React.useCallback(
      (secretId) =>
        runControlPlane({
          execute: (client) => client.local.deleteSecret({
            path: { secretId },
          }),
        }),
      [],
    ),
  );

export const useSources = (): Loadable<ReadonlyArray<Source>> => {
  const workspace = useWorkspaceRequestContext();
  const key = encodeSourcesKey(workspace.enabled, workspace.workspaceId, workspace.accountId);
  useTrackActiveKey("sourceLists", key, workspace.enabled);
  const sources = useLoadableAtom(sourcesAtom(key));

  return workspace.enabled ? sources : pendingLoadable(workspace.workspace);
};

export const useSource = (sourceId: string): Loadable<Source> => {
  const workspace = useWorkspaceRequestContext();
  const requestedSourceId = workspace.enabled
    ? (sourceId as Source["id"])
    : PLACEHOLDER_SOURCE_ID;
  const key = encodeSourceKey(
    workspace.enabled,
    workspace.workspaceId,
    workspace.accountId,
    requestedSourceId,
  );
  useTrackActiveKey("sources", key, workspace.enabled);
  const source = useLoadableAtom(sourceAtom(key));

  return workspace.enabled ? source : pendingLoadable(workspace.workspace);
};

export const useWorkspaceOauthClients = (
  providerKey: string | null,
): Loadable<ReadonlyArray<WorkspaceOauthClient>> => {
  const workspace = useWorkspaceRequestContext();
  const key = encodeWorkspaceOauthClientsKey(
    workspace.enabled && providerKey !== null,
    workspace.workspaceId,
    workspace.accountId,
    providerKey ?? "",
  );
  useTrackActiveKey(
    "workspaceOauthClients",
    key,
    workspace.enabled && providerKey !== null,
  );
  const oauthClients = useLoadableAtom(workspaceOauthClientsAtom(key));

  if (!workspace.enabled) {
    return pendingLoadable(workspace.workspace);
  }

  if (providerKey === null) {
    return {
      status: "ready",
      data: [],
    };
  }

  return oauthClients;
};

export const useSourceInspection = (sourceId: string): Loadable<SourceInspection> => {
  const workspace = useWorkspaceRequestContext();
  const requestedSourceId = workspace.enabled
    ? (sourceId as Source["id"])
    : PLACEHOLDER_SOURCE_ID;
  const key = encodeSourceKey(
    workspace.enabled,
    workspace.workspaceId,
    workspace.accountId,
    requestedSourceId,
  );
  useTrackActiveKey("inspections", key, workspace.enabled);
  const inspection = useLoadableAtom(sourceInspectionAtom(key));

  return workspace.enabled ? inspection : pendingLoadable(workspace.workspace);
};

export const useSourceToolDetail = (
  sourceId: string,
  toolPath: string | null,
): Loadable<SourceInspectionToolDetail | null> => {
  const workspace = useWorkspaceRequestContext();
  const requestedSourceId = workspace.enabled
    ? (sourceId as Source["id"])
    : PLACEHOLDER_SOURCE_ID;
  const key = encodeToolDetailKey(
    workspace.enabled,
    workspace.workspaceId,
    workspace.accountId,
    requestedSourceId,
    toolPath,
  );
  useTrackActiveKey("toolDetails", key, workspace.enabled && toolPath !== null);
  const detail = useLoadableAtom(sourceInspectionToolAtom(key));

  return workspace.enabled ? detail : pendingLoadable(workspace.workspace);
};

export const useSourceDiscovery = (input: {
  sourceId: string;
  query: string;
  limit?: number;
}): Loadable<SourceInspectionDiscoverResult> => {
  const workspace = useWorkspaceRequestContext();
  const requestedSourceId = workspace.enabled
    ? (input.sourceId as Source["id"])
    : PLACEHOLDER_SOURCE_ID;
  const key = encodeDiscoveryKey(
    workspace.enabled,
    workspace.workspaceId,
    workspace.accountId,
    requestedSourceId,
    input.query,
    input.limit ?? null,
  );
  useTrackActiveKey("discoveries", key, workspace.enabled);
  const results = useLoadableAtom(sourceDiscoveryAtom(key));

  return workspace.enabled ? results : pendingLoadable(workspace.workspace);
};

export const usePrefetchToolDetail = () => {
  const registry = React.useContext(RegistryContext);
  const workspace = useWorkspaceRequestContext();

  return React.useCallback(
    (sourceId: string, toolPath: string): (() => void) => {
      if (!workspace.enabled) return () => {};
      const requestedSourceId = sourceId as Source["id"];
      const atom = sourceInspectionToolAtom(
        encodeToolDetailKey(
          workspace.enabled,
          workspace.workspaceId,
          workspace.accountId,
          requestedSourceId,
          toolPath,
        ),
      );
      return registry.mount(atom);
    },
    [registry, workspace.accountId, workspace.enabled, workspace.workspaceId],
  );
};

export const useCreateSource = () =>
  useSourceMutation<CreateSourcePayload, Source, Source>(
    React.useCallback(
      ({ workspaceId, accountId, payload }) =>
        runControlPlane({
          accountId,
          execute: (client) => client.sources.create({
            path: {
              workspaceId,
            },
            payload,
          }),
        }),
      [],
    ),
    {
      optimisticUpdate: (context, payload) => {
        const listAtom = sourcesAtom(encodeSourcesKey(true, context.workspaceId, context.accountId));
        const previousList = getCachedAtomValue(context.registry, listAtom);
        if (previousList === undefined) {
          return;
        }

        const optimisticSource = createOptimisticSource({
          workspaceId: context.workspaceId,
          payload,
        });
        setCachedAtomValue(context.registry, listAtom, [optimisticSource, ...previousList]);
        return {
          value: optimisticSource,
          rollback: () => {
            setCachedAtomValue(context.registry, listAtom, previousList);
          },
        };
      },
      onSuccess: (context, _payload, source, optimisticSource) => {
        const listAtom = sourcesAtom(encodeSourcesKey(true, context.workspaceId, context.accountId));
        const currentList = getCachedAtomValue(context.registry, listAtom);
        if (currentList !== undefined) {
          const withoutOptimistic = optimisticSource
            ? currentList.filter((candidate) => candidate.id !== optimisticSource.id)
            : currentList;
          setCachedAtomValue(context.registry, listAtom, upsertSourceInList(withoutOptimistic, source));
        }

        setCachedAtomValue(
          context.registry,
          sourceAtom(encodeSourceKey(true, context.workspaceId, context.accountId, source.id)),
          source,
        );
        context.invalidateQueries({
          workspaceId: context.workspaceId,
          accountId: context.accountId,
        });
      },
    },
  );

export const useUpdateSource = () =>
  useSourceMutation<{ sourceId: Source["id"]; payload: UpdateSourcePayload }, Source>(
    React.useCallback(
      ({ workspaceId, accountId, payload }) =>
        runControlPlane({
          accountId,
          execute: (client) => client.sources.update({
            path: {
              workspaceId,
              sourceId: payload.sourceId,
            },
            payload: payload.payload,
          }),
        }),
      [],
    ),
    {
      optimisticUpdate: (context, input) => {
        const listAtom = sourcesAtom(encodeSourcesKey(true, context.workspaceId, context.accountId));
        const detailAtom = sourceAtom(encodeSourceKey(true, context.workspaceId, context.accountId, input.sourceId));
        const previousList = getCachedAtomValue(context.registry, listAtom);
        const previousSource = getCachedAtomValue(context.registry, detailAtom)
          ?? previousList?.find((source) => source.id === input.sourceId);
        if (previousSource === undefined) {
          return;
        }

        const optimisticSource = applyUpdatePayloadToSource(previousSource, input.payload);
        if (previousList !== undefined) {
          setCachedAtomValue(context.registry, listAtom, upsertSourceInList(previousList, optimisticSource));
        }
        setCachedAtomValue(context.registry, detailAtom, optimisticSource);

        return () => {
          if (previousList !== undefined) {
            setCachedAtomValue(context.registry, listAtom, previousList);
          }
          setCachedAtomValue(context.registry, detailAtom, previousSource);
        };
      },
      onSuccess: (context, input, source) => {
        const listAtom = sourcesAtom(encodeSourcesKey(true, context.workspaceId, context.accountId));
        const detailAtom = sourceAtom(encodeSourceKey(true, context.workspaceId, context.accountId, input.sourceId));
        const currentList = getCachedAtomValue(context.registry, listAtom);
        if (currentList !== undefined) {
          setCachedAtomValue(context.registry, listAtom, upsertSourceInList(currentList, source));
        }
        setCachedAtomValue(context.registry, detailAtom, source);
        context.invalidateQueries({
          workspaceId: context.workspaceId,
          accountId: context.accountId,
          sourceId: input.sourceId,
        });
      },
    },
  );

export const useRemoveSource = () =>
  useSourceMutation<Source["id"], SourceRemoveResult>(
    React.useCallback(
      ({ workspaceId, accountId, payload }) =>
        runControlPlane({
          accountId,
          execute: (client) => client.sources.remove({
            path: {
              workspaceId,
              sourceId: payload,
            },
          }),
        }),
      [],
    ),
    {
      optimisticUpdate: (context, sourceId) => {
        const listAtom = sourcesAtom(encodeSourcesKey(true, context.workspaceId, context.accountId));
        const previousList = getCachedAtomValue(context.registry, listAtom);
        if (previousList === undefined) {
          return;
        }

        setCachedAtomValue(context.registry, listAtom, removeSourceFromList(previousList, sourceId));
        return () => {
          setCachedAtomValue(context.registry, listAtom, previousList);
        };
      },
      onSuccess: (context, sourceId) => {
        context.invalidateQueries({
          workspaceId: context.workspaceId,
          accountId: context.accountId,
          sourceId,
        });
      },
    },
  );

export const useDiscoverSource = () =>
  useSourceMutation<DiscoverSourcePayload, SourceDiscoveryResult>(
    React.useCallback(
      ({ accountId, payload }) =>
        runControlPlane({
          accountId,
          execute: (client) => client.sources.discover({
            payload,
          }),
        }),
      [],
    ),
  );

export const useCreateWorkspaceOauthClient = () =>
  useSourceMutation<CreateWorkspaceOauthClientPayload, WorkspaceOauthClient>(
    React.useCallback(
      ({ workspaceId, accountId, payload }) =>
        runControlPlane({
          accountId,
          execute: (client) => client.sources.createWorkspaceOauthClient({
            path: {
              workspaceId,
            },
            payload,
          }),
        }),
      [],
    ),
    {
      onSuccess: (context) => {
        context.invalidateQueries({
          workspaceId: context.workspaceId,
          accountId: context.accountId,
        });
      },
    },
  );

export const useRemoveWorkspaceOauthClient = () =>
  useSourceMutation<WorkspaceOauthClient["id"], { removed: boolean }>(
    React.useCallback(
      ({ workspaceId, accountId, payload }) =>
        runControlPlane({
          accountId,
          execute: (client) => client.sources.removeWorkspaceOauthClient({
            path: {
              workspaceId,
              oauthClientId: payload,
            },
          }),
        }),
      [],
    ),
    {
      onSuccess: (context) => {
        context.invalidateQueries({
          workspaceId: context.workspaceId,
          accountId: context.accountId,
        });
      },
    },
  );

export const useRemoveProviderAuthGrant = () =>
  useSourceMutation<
    Extract<Source["auth"], { kind: "provider_grant_ref" }>["grantId"],
    { removed: boolean }
  >(
    React.useCallback(
      ({ workspaceId, accountId, payload }) =>
        runControlPlane({
          accountId,
          execute: (client) => client.sources.removeProviderAuthGrant({
            path: {
              workspaceId,
              grantId: payload,
            },
          }),
        }),
      [],
    ),
    {
      onSuccess: (context) => {
        context.invalidateQueries({
          workspaceId: context.workspaceId,
          accountId: context.accountId,
        });
      },
    },
  );

export type {
  CreateSecretPayload,
  CreateSecretResult,
  CreateSourcePayload,
  CreateWorkspaceOauthClientPayload,
  DeleteSecretResult,
  DiscoverSourcePayload,
  InstanceConfig,
  LocalInstallation,

  SecretListItem,
  Source,
  SourceDiscoveryResult,
  SourceInspection,
  SourceInspectionDiscoverResult,
  SourceInspectionToolDetail,
  UpdateSecretPayload,
  UpdateSecretResult,
  UpdateSourcePayload,
  WorkspaceOauthClient,
};

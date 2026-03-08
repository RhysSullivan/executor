import { Atom, Result } from "@effect-atom/atom";
import { RegistryContext, RegistryProvider, useAtomValue } from "@effect-atom/atom-react";
import type {
  LocalInstallation,
  Source,
  SourceInspection,
  SourceInspectionDiscoverResult,
  SourceInspectionToolDetail,
} from "@executor-v3/control-plane/schema";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as React from "react";

const DEFAULT_EXECUTOR_API_BASE_URL = "http://127.0.0.1:8788";
const ACCOUNT_HEADER = "x-executor-account-id";
const PLACEHOLDER_WORKSPACE_ID = "ws_placeholder" as Source["workspaceId"];
const PLACEHOLDER_ACCOUNT_ID = "acc_placeholder";
const PLACEHOLDER_SOURCE_ID = "src_placeholder" as Source["id"];

let apiBaseUrl =
  typeof window !== "undefined" && typeof window.location?.origin === "string"
    ? window.location.origin
    : DEFAULT_EXECUTOR_API_BASE_URL;

type AtomKeyPart = string | number | boolean | null | undefined;

const encodeAtomKey = (parts: ReadonlyArray<AtomKeyPart>): string => JSON.stringify(parts);

const decodeAtomKey = <T extends ReadonlyArray<AtomKeyPart>>(key: string): T => JSON.parse(key) as T;

const causeMessage = (cause: Cause.Cause<unknown>): Error =>
  new Error(Cause.pretty(cause));

const requestJson = async <A>(input: {
  path: string;
  accountId?: string;
  method?: "GET" | "POST";
  payload?: unknown;
}): Promise<A> => {
  const response = await fetch(new URL(input.path, apiBaseUrl), {
    method: input.method ?? "GET",
    headers: {
      ...(input.accountId ? { [ACCOUNT_HEADER]: input.accountId } : {}),
      ...(input.payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(input.payload !== undefined ? { body: JSON.stringify(input.payload) } : {}),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<A>;
};

const localInstallationAtom = Atom.make(
  Effect.promise(() => requestJson<LocalInstallation>({ path: "/v1/local/installation" })),
).pipe(Atom.keepAlive);

const sourcesAtom = Atom.family((key: string) => {
  const [enabled, workspaceId, accountId] = decodeAtomKey<
    readonly [boolean, Source["workspaceId"], string]
  >(key);

  return Atom.make(
    enabled
      ? Effect.promise(() =>
          requestJson<ReadonlyArray<Source>>({
            path: `/v1/workspaces/${workspaceId}/sources`,
            accountId,
          }),
        )
      : Effect.never,
  ).pipe(Atom.keepAlive);
});

const sourceInspectionAtom = Atom.family((key: string) => {
  const [enabled, workspaceId, accountId, sourceId] = decodeAtomKey<
    readonly [boolean, Source["workspaceId"], string, Source["id"]]
  >(key);

  return Atom.make(
    enabled
      ? Effect.promise(() =>
          requestJson<SourceInspection>({
            path: `/v1/workspaces/${workspaceId}/sources/${sourceId}/inspection`,
            accountId,
          }),
        )
      : Effect.never,
  ).pipe(Atom.keepAlive);
});

const sourceInspectionToolAtom = Atom.family((key: string) => {
  const [enabled, workspaceId, accountId, sourceId, toolPath] = decodeAtomKey<
    readonly [boolean, Source["workspaceId"], string, Source["id"], string | null]
  >(key);

  return Atom.make(
    enabled && toolPath
      ? Effect.promise(() =>
          requestJson<SourceInspectionToolDetail>({
            path: `/v1/workspaces/${workspaceId}/sources/${sourceId}/tools/${encodeURIComponent(toolPath)}/inspection`,
            accountId,
          }),
        )
      : Effect.succeed<SourceInspectionToolDetail | null>(null),
  ).pipe(Atom.keepAlive);
});

const sourceDiscoveryAtom = Atom.family((key: string) => {
  const [enabled, workspaceId, accountId, sourceId, query, limit] = decodeAtomKey<
    readonly [boolean, Source["workspaceId"], string, Source["id"], string, number | null]
  >(key);

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
        : Effect.promise(() =>
            requestJson<SourceInspectionDiscoverResult>({
              path: `/v1/workspaces/${workspaceId}/sources/${sourceId}/inspection/discover`,
              accountId,
              method: "POST",
              payload: {
                query,
                ...(limit !== null ? { limit } : {}),
              },
            }),
          ),
  ).pipe(Atom.keepAlive);
});

export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; data: T };

type WorkspaceContext = {
  installation: LocalInstallation;
  workspaceId: Source["workspaceId"];
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
  const installation = useLoadableAtom(localInstallationAtom);

  return React.useMemo(() => {
    if (installation.status !== "ready") {
      return installation;
    }

    return {
      status: "ready",
      data: {
        installation: installation.data,
        workspaceId: installation.data.workspaceId,
        accountId: installation.data.accountId,
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

export const setExecutorApiBaseUrl = (baseUrl: string): void => {
  apiBaseUrl = baseUrl;
};

export const ExecutorReactProvider = RegistryProvider;

export const useLocalInstallation = (): Loadable<LocalInstallation> =>
  useLoadableAtom(localInstallationAtom);

export const useSources = (): Loadable<ReadonlyArray<Source>> => {
  const workspace = useWorkspaceRequestContext();
  const sources = useLoadableAtom(
    sourcesAtom(
      encodeAtomKey([workspace.enabled, workspace.workspaceId, workspace.accountId]),
    ),
  );

  return workspace.enabled ? sources : pendingLoadable(workspace.workspace);
};

export const useSourceInspection = (sourceId: string): Loadable<SourceInspection> => {
  const workspace = useWorkspaceRequestContext();
  const requestedSourceId = workspace.enabled
    ? (sourceId as Source["id"])
    : PLACEHOLDER_SOURCE_ID;
  const inspection = useLoadableAtom(
    sourceInspectionAtom(
      encodeAtomKey([
        workspace.enabled,
        workspace.workspaceId,
        workspace.accountId,
        requestedSourceId,
      ]),
    ),
  );

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
  const detail = useLoadableAtom(
    sourceInspectionToolAtom(
      encodeAtomKey([
        workspace.enabled,
        workspace.workspaceId,
        workspace.accountId,
        requestedSourceId,
        toolPath,
      ]),
    ),
  );

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
  const results = useLoadableAtom(
    sourceDiscoveryAtom(
      encodeAtomKey([
        workspace.enabled,
        workspace.workspaceId,
        workspace.accountId,
        requestedSourceId,
        input.query,
        input.limit ?? null,
      ]),
    ),
  );

  return workspace.enabled ? results : pendingLoadable(workspace.workspace);
};

// ---------------------------------------------------------------------------
// Prefetching
// ---------------------------------------------------------------------------

/**
 * Returns a function that imperatively triggers a fetch for a tool detail.
 * Because the atom family uses `Atom.keepAlive`, the fetched result persists
 * in the registry. When the user later selects the tool, `useSourceToolDetail`
 * gets an instant cache hit.
 *
 * Usage: call the returned function on pointer-enter with a short delay.
 * It returns a cleanup function (unmounts the atom subscription).
 */
export const usePrefetchToolDetail = () => {
  const registry = React.useContext(RegistryContext);
  const workspace = useWorkspaceRequestContext();

  return React.useCallback(
    (sourceId: string, toolPath: string): (() => void) => {
      if (!workspace.enabled) return () => {};
      const requestedSourceId = sourceId as Source["id"];
      const atom = sourceInspectionToolAtom(
        encodeAtomKey([
          workspace.enabled,
          workspace.workspaceId,
          workspace.accountId,
          requestedSourceId,
          toolPath,
        ]),
      );
      // mount triggers the fetch; returns a dispose function
      return registry.mount(atom);
    },
    [registry, workspace.enabled, workspace.workspaceId, workspace.accountId],
  );
};

export type {
  LocalInstallation,
  Source,
  SourceInspection,
  SourceInspectionDiscoverResult,
  SourceInspectionToolDetail,
};

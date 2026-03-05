import { Atom, Result } from "@effect-atom/atom";
import type { WorkspaceId } from "@executor-v2/schema";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

// ---------------------------------------------------------------------------
// Shared state shape — every entity uses the same discriminated union.
// ---------------------------------------------------------------------------

export type EntityState<T> =
  | { state: "loading"; items: ReadonlyArray<T>; message: null }
  | { state: "error"; items: ReadonlyArray<T>; message: string }
  | { state: "ready"; items: ReadonlyArray<T>; message: null };

// ---------------------------------------------------------------------------
// Result → EntityState mapper (replaces the 8 copy-pasted xxxStateFromResult)
// ---------------------------------------------------------------------------

const emptyArray: ReadonlyArray<never> = [];

export const stateFromResult = <T>(
  result: Result.Result<ReadonlyArray<T>, unknown>,
  sort?: (items: ReadonlyArray<T>) => Array<T>,
): EntityState<T> =>
  Result.match(result, {
    onInitial: () => ({
      state: "loading" as const,
      items: emptyArray as ReadonlyArray<T>,
      message: null,
    }),
    onFailure: (failure) => ({
      state: "error" as const,
      items: Option.getOrElse(
        Result.value(result),
        () => emptyArray as ReadonlyArray<T>,
      ),
      message: Cause.pretty(failure.cause),
    }),
    onSuccess: (success) => ({
      state: "ready" as const,
      items: sort ? sort(success.value) : success.value,
      message: null,
    }),
  });

// ---------------------------------------------------------------------------
// Workspace-scoped entity atom factory
//
// Given a query atom family and a sort function, produces a derived state atom
// family keyed by workspaceId. Eliminates the per-entity boilerplate of
// defining XxxResult, XxxState, sortXxx, xxxStateFromResult, xxxByWorkspace.
// ---------------------------------------------------------------------------

export const workspaceEntity = <T>(
  resultFamily: (workspaceId: WorkspaceId) => Atom.Atom<Result.Result<ReadonlyArray<T>, unknown>>,
  sort: (a: T, b: T) => number,
) =>
  Atom.family((workspaceId: WorkspaceId) =>
    Atom.make((get): EntityState<T> =>
      stateFromResult(
        get(resultFamily(workspaceId)),
        (items) => [...items].sort(sort),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Global (non-workspace-scoped) entity atom factory
// ---------------------------------------------------------------------------

export const globalEntity = <T>(
  resultAtom: Atom.Atom<Result.Result<ReadonlyArray<T>, unknown>>,
  sort: (a: T, b: T) => number,
) =>
  Atom.make((get): EntityState<T> =>
    stateFromResult(
      get(resultAtom),
      (items) => [...items].sort(sort),
    ),
  );

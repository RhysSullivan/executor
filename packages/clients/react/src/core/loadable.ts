import {
  Atom,
  Result,
  useAtomValue,
} from "@effect-atom/atom-react";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as React from "react";

import type { Loadable } from "./types";

const causeMessage = (cause: Cause.Cause<unknown>): Error =>
  new Error(Cause.pretty(cause));

export const toLoadable = <T>(result: Result.Result<T, unknown>): Loadable<T> => {
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

export const pendingResultAtom = Atom.make(
  Effect.never as Effect.Effect<never, Error>,
).pipe(Atom.keepAlive);

export const pendingLoadable = <T>(
  workspace: Loadable<unknown>,
): Loadable<T> => {
  if (workspace.status === "loading") {
    return { status: "loading" };
  }

  if (workspace.status === "error") {
    return { status: "error", error: workspace.error };
  }

  throw new Error("Expected workspace loadable to be pending or errored");
};

export const useLoadableAtom = <T>(
  atom: Atom.Atom<Result.Result<T, unknown>>,
): Loadable<T> => {
  const result = useAtomValue(atom);
  return React.useMemo(() => toLoadable(result), [result]);
};

export const disabledAtom = <T>() =>
  pendingResultAtom as unknown as Atom.Atom<Result.Result<T, unknown>>;

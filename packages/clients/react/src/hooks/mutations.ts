import * as React from "react";

import type { MutationState } from "../core/types";

export const useExecutorMutation = <TInput, TOutput>(
  execute: (input: TInput) => Promise<TOutput>,
) => {
  const [state, setState] = React.useState<MutationState<TOutput>>({
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
      setState({ status: "success", data, error: null });
      return data;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setState({ status: "error", data: null, error });
      throw error;
    }
  }, [execute]);

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

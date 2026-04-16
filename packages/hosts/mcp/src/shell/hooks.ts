import { useState, useCallback, useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// useQuery — data fetching with loading/error/data states
// ---------------------------------------------------------------------------

export type UseQueryResult<T> = {
  data: T | undefined;
  error: Error | undefined;
  isLoading: boolean;
  refetch: () => Promise<void>;
};

export function useQuery<T>(fn: () => Promise<T>): UseQueryResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const refetch = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      const result = await fnRef.current();
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, error, isLoading, refetch };
}

// ---------------------------------------------------------------------------
// useMutation — mutations with pending/error/data states + invalidation
// ---------------------------------------------------------------------------

export type UseMutationOptions<_TInput, _TData> = {
  invalidates?: Array<{ refetch: () => void }>;
  onSuccess?: (data: _TData) => void;
  onError?: (error: Error) => void;
};

export type UseMutationResult<TInput, TData> = {
  mutate: (input: TInput) => Promise<TData | undefined>;
  data: TData | undefined;
  error: Error | undefined;
  isPending: boolean;
  reset: () => void;
};

export function useMutation<TInput, TData = unknown>(
  fn: (input: TInput) => Promise<TData>,
  opts?: UseMutationOptions<TInput, TData>,
): UseMutationResult<TInput, TData> {
  const [data, setData] = useState<TData | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [isPending, setIsPending] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const mutate = useCallback(async (input: TInput): Promise<TData | undefined> => {
    setIsPending(true);
    setError(undefined);
    try {
      const result = await fnRef.current(input);
      setData(result);
      optsRef.current?.onSuccess?.(result);
      // Invalidate dependent queries
      optsRef.current?.invalidates?.forEach((q) => q.refetch());
      return result;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      optsRef.current?.onError?.(err);
      return undefined;
    } finally {
      setIsPending(false);
    }
  }, []);

  const reset = useCallback(() => {
    setData(undefined);
    setError(undefined);
    setIsPending(false);
  }, []);

  return { mutate, data, error, isPending, reset };
}

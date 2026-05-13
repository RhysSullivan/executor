import { useRef } from "react";
import {
  QueryClient,
  QueryClientProvider,
  mutationOptions,
  queryOptions,
  skipToken,
  useMutation as useTanStackMutation,
  useQuery as useTanStackQuery,
  useQueryClient,
  type MutationKey,
  type QueryClient as QueryClientType,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";

export {
  QueryClient,
  QueryClientProvider,
  mutationOptions,
  queryOptions,
  skipToken,
  useQueryClient,
};

let legacyQueryId = 0;
let legacyMutationId = 0;

type RefetchableQuery = {
  refetch: () => unknown;
};

type LegacyMutationOptions<TData, TError, TVariables, TContext> = UseMutationOptions<
  TData,
  TError,
  TVariables,
  TContext
> & {
  invalidates?: readonly RefetchableQuery[];
};

const nextLegacyQueryKey = (): QueryKey => ["executor", "legacy-query", ++legacyQueryId];
const nextLegacyMutationKey = (): MutationKey => [
  "executor",
  "legacy-mutation",
  ++legacyMutationId,
];

/**
 * TanStack Query's `useQuery`, plus compatibility for the original generated
 * UI shorthand: `useQuery(() => tools.namespace.tool(args))`.
 */
export function useQuery<TData>(fn: () => Promise<TData>): UseQueryResult<TData, Error>;
export function useQuery<
  TQueryFnData,
  TError = Error,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  queryClient?: QueryClientType,
): UseQueryResult<TData, TError>;
export function useQuery(
  optionsOrFn: unknown,
  queryClient?: QueryClientType,
): UseQueryResult<unknown, Error> {
  const legacyFnRef = useRef<(() => Promise<unknown>) | null>(null);
  const legacyQueryKeyRef = useRef<QueryKey | null>(null);

  if (typeof optionsOrFn === "function") {
    legacyFnRef.current = optionsOrFn as () => Promise<unknown>;
    legacyQueryKeyRef.current ??= nextLegacyQueryKey();
    return useTanStackQuery(
      {
        queryKey: legacyQueryKeyRef.current,
        queryFn: () => {
          const current = legacyFnRef.current;
          if (!current) throw new Error("Missing legacy query function.");
          return current();
        },
      },
      queryClient,
    );
  }

  return useTanStackQuery(
    optionsOrFn as UseQueryOptions<unknown, Error, unknown, QueryKey>,
    queryClient,
  );
}

/**
 * TanStack Query's `useMutation`, plus compatibility for the original generated
 * UI shorthand: `useMutation((input) => tools.namespace.tool(input), opts)`.
 */
export function useMutation<TVariables, TData = unknown, TContext = unknown>(
  fn: (input: TVariables) => Promise<TData>,
  options?: LegacyMutationOptions<TData, Error, TVariables, TContext>,
): UseMutationResult<TData, Error, TVariables, TContext>;
export function useMutation<TData = unknown, TError = Error, TVariables = void, TContext = unknown>(
  options: UseMutationOptions<TData, TError, TVariables, TContext>,
  queryClient?: QueryClientType,
): UseMutationResult<TData, TError, TVariables, TContext>;
export function useMutation(
  optionsOrFn: unknown,
  optionsOrQueryClient?: unknown,
): UseMutationResult<unknown, Error, unknown, unknown> {
  const legacyMutationKeyRef = useRef<MutationKey | null>(null);
  legacyMutationKeyRef.current ??= nextLegacyMutationKey();

  if (typeof optionsOrFn === "function") {
    const legacyOptions =
      (optionsOrQueryClient as
        | LegacyMutationOptions<unknown, Error, unknown, unknown>
        | undefined) ?? {};
    const { invalidates, onSuccess, ...tanstackOptions } = legacyOptions;

    return useTanStackMutation({
      mutationKey: legacyOptions.mutationKey ?? legacyMutationKeyRef.current,
      ...tanstackOptions,
      mutationFn: optionsOrFn as (input: unknown) => Promise<unknown>,
      onSuccess: async (data, variables, context, mutationContext) => {
        await onSuccess?.(data, variables, context, mutationContext);
        await Promise.all(invalidates?.map((query) => query.refetch()) ?? []);
      },
    });
  }

  return useTanStackMutation(
    optionsOrFn as UseMutationOptions<unknown, Error, unknown, unknown>,
    optionsOrQueryClient as QueryClientType | undefined,
  );
}

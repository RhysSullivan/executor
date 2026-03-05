import type { ReactNode } from "react";

import type { EntityState } from "../../lib/control-plane/atoms";
import { EmptyState } from "./empty-state";
import { LoadingState } from "./loading-state";
import { StatusMessage } from "./status-message";

// ---------------------------------------------------------------------------
// matchState — eliminates the repeated loading/error/empty conditionals
// across every view component.
//
// Usage:
//   matchState(state, {
//     loading: "Loading sources...",
//     empty: sourceItems.length === 0 ? "No sources yet." : "No matches.",
//     ready: (items) => <SourceList items={items} />,
//   })
//
// The `filteredCount` option lets you provide a filtered subset for the empty
// check while the full item list is still used for the "ready" callback.
// ---------------------------------------------------------------------------

type MatchStateOptions<T> = {
  loading?: string;
  empty: string | null;
  ready: (items: ReadonlyArray<T>) => ReactNode;
  filteredCount?: number;
};

export function matchState<T>(
  state: EntityState<T>,
  options: MatchStateOptions<T>,
): ReactNode {
  if (state.state === "loading") {
    return <LoadingState message={options.loading ?? "Loading..."} />;
  }

  const isEmpty =
    options.filteredCount !== undefined
      ? options.filteredCount === 0
      : state.items.length === 0;

  return (
    <>
      {state.state === "error" ? (
        <StatusMessage message={state.message} variant="error" />
      ) : null}
      {isEmpty
        ? options.empty !== null
          ? <EmptyState message={options.empty} />
          : null
        : options.ready(state.items)}
    </>
  );
}

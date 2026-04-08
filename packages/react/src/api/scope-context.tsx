import * as React from "react";
import { useAtomValue, Result } from "@effect-atom/atom-react";

import type { ScopeId } from "@executor/core";
import { scopeAtom } from "./atoms";

export interface ScopeInfo {
  readonly id: ScopeId;
  readonly name: string;
  readonly dir: string;
}

const ScopeContext = React.createContext<ScopeInfo | null>(null);

/**
 * Provides the server scope to all children.
 * Renders nothing until the scope is fetched.
 */
export function ScopeProvider(props: React.PropsWithChildren) {
  const result = useAtomValue(scopeAtom);

  if (Result.isSuccess(result)) {
    return (
      <ScopeContext.Provider value={result.value}>
        {props.children}
      </ScopeContext.Provider>
    );
  }

  // Loading or error — don't render children
  return null;
}

/**
 * Returns the current scope ID.
 * Must be used inside a ScopeProvider (which gates rendering until scope is loaded).
 */
export function useScope(): ScopeId {
  const scope = React.useContext(ScopeContext);
  if (scope === null) {
    throw new Error("useScope must be used inside a ScopeProvider");
  }
  return scope.id;
}

/**
 * Returns the full scope info (id + display name).
 * Must be used inside a ScopeProvider.
 */
export function useScopeInfo(): ScopeInfo {
  const scope = React.useContext(ScopeContext);
  if (scope === null) {
    throw new Error("useScopeInfo must be used inside a ScopeProvider");
  }
  return scope;
}

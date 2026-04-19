import * as React from "react";
import { useAtomValue, Result } from "@effect-atom/atom-react";

import type { ScopeId } from "@executor/sdk";
import { scopeAtom } from "./atoms";

export interface ScopeChainEntry {
  readonly id: ScopeId;
  readonly name: string;
}

export interface ScopeInfo {
  readonly id: ScopeId;
  readonly name: string;
  readonly dir: string;
  /** Full read chain innermost-first. Single-element for CLI/local
   *  hosts; `[user, org]` for cloud hosts that layer per-user over
   *  per-org scopes. Consumers that need to offer a scope picker or
   *  label rows by scope read this. */
  readonly chain: readonly ScopeChainEntry[];
}

const ScopeContext = React.createContext<ScopeInfo | null>(null);

/**
 * Provides the server scope to all children.
 * Renders the optional `fallback` until the scope is fetched.
 */
export function ScopeProvider(
  props: React.PropsWithChildren<{ fallback?: React.ReactNode }>,
) {
  const result = useAtomValue(scopeAtom);

  if (Result.isSuccess(result)) {
    return <ScopeContext.Provider value={result.value}>{props.children}</ScopeContext.Provider>;
  }

  return <>{props.fallback ?? null}</>;
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

/**
 * Returns the caller's full read chain (innermost-first). Multi-scope
 * hosts (cloud) expose `[user, org]`; single-scope hosts return a
 * one-element array. UI surfaces that want to offer "personal vs
 * shared" can key off `chain.length > 1`.
 */
export function useScopeChain(): readonly ScopeChainEntry[] {
  const scope = React.useContext(ScopeContext);
  if (scope === null) {
    throw new Error("useScopeChain must be used inside a ScopeProvider");
  }
  return scope.chain;
}

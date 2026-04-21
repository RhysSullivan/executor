import type { ScopeId, ToolId, SecretId } from "@executor/sdk";
import { Atom } from "@effect-atom/atom-react";

import { ExecutorApiClient } from "./client";
import { ReactivityKey } from "./reactivity-keys";

// ---------------------------------------------------------------------------
// Scope — fetched from the server
// ---------------------------------------------------------------------------

export const scopeAtom = ExecutorApiClient.query("scope", "info", {
  timeToLive: "5 minutes",
  reactivityKeys: [ReactivityKey.scope],
});

// ---------------------------------------------------------------------------
// Query atoms — typed, cached, reactive
// ---------------------------------------------------------------------------

export const toolsAtom = (scopeId: ScopeId) =>
  ExecutorApiClient.query("tools", "list", {
    path: { scopeId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.tools],
  });

/** Tools for a specific source */
export const sourceToolsAtom = (sourceId: string, scopeId: ScopeId) =>
  ExecutorApiClient.query("sources", "tools", {
    path: { scopeId, sourceId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.tools],
  });

export const toolSchemaAtom = (scopeId: ScopeId, toolId: ToolId) =>
  ExecutorApiClient.query("tools", "schema", {
    path: { scopeId, toolId },
    timeToLive: "1 minute",
    reactivityKeys: [ReactivityKey.tools],
  });

export const sourcesAtom = (scopeId: ScopeId) =>
  ExecutorApiClient.query("sources", "list", {
    path: { scopeId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.sources],
  });

/** Single source by id — derived from the sources list */
export const sourceAtom = (sourceId: string, scopeId: ScopeId) =>
  Atom.mapResult(sourcesAtom(scopeId), (sources) => sources.find((s) => s.id === sourceId) ?? null);

export const secretsAtom = (scopeId: ScopeId) =>
  ExecutorApiClient.query("secrets", "list", {
    path: { scopeId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.secrets],
  });

export const secretStatusAtom = (scopeId: ScopeId, secretId: SecretId) =>
  ExecutorApiClient.query("secrets", "status", {
    path: { scopeId, secretId },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.secrets],
  });

export const connectionsAtom = (scopeId: ScopeId) =>
  ExecutorApiClient.query("connections", "list", {
    path: { scopeId },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.connections],
  });

// ---------------------------------------------------------------------------
// Mutation atoms — reactivityKeys must be passed at call site (effect-atom
// does not accept them at definition time). See `reactivity-keys.tsx` for the
// canonical key arrays.
// ---------------------------------------------------------------------------

export const setSecret = ExecutorApiClient.mutation("secrets", "set");

export const resolveSecret = ExecutorApiClient.mutation("secrets", "resolve");

export const removeSecret = ExecutorApiClient.mutation("secrets", "remove");

export const removeConnection = ExecutorApiClient.mutation(
  "connections",
  "remove",
);

export const removeSource = ExecutorApiClient.mutation("sources", "remove");

export const refreshSource = ExecutorApiClient.mutation("sources", "refresh");

export const detectSource = ExecutorApiClient.mutation("sources", "detect");

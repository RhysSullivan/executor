import type { ScopeId } from "@executor-js/sdk/core";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { GraphqlClient } from "./client";

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const graphqlSourceAtom = (scopeId: ScopeId, namespace: string) =>
  GraphqlClient.query("graphql", "getSource", {
    path: { scopeId, namespace },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.sources, ReactivityKey.tools],
  });

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

export const addGraphqlSource = GraphqlClient.mutation("graphql", "addSource");

export const updateGraphqlSource = GraphqlClient.mutation("graphql", "updateSource");

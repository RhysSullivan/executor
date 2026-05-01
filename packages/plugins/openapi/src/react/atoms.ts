import type { ScopeId } from "@executor-js/sdk/core";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { OpenApiClient } from "./client";

// ---------------------------------------------------------------------------
// Query atoms
// ---------------------------------------------------------------------------

export const openApiSourceAtom = (scopeId: ScopeId, namespace: string) =>
  OpenApiClient.query("openapi", "getSource", {
    path: { scopeId, namespace },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.sources, ReactivityKey.tools],
  });

export const openApiSourceBindingsAtom = (
  scopeId: ScopeId,
  namespace: string,
  sourceScopeId: ScopeId,
) =>
  OpenApiClient.query("openapi", "listSourceBindings", {
    path: { scopeId, namespace, sourceScopeId },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.sources, ReactivityKey.secrets, ReactivityKey.connections],
  });

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

export const previewOpenApiSpec = OpenApiClient.mutation("openapi", "previewSpec");

export const addOpenApiSpec = OpenApiClient.mutation("openapi", "addSpec");

export const updateOpenApiSource = OpenApiClient.mutation("openapi", "updateSource");

export const setOpenApiSourceBinding = OpenApiClient.mutation("openapi", "setSourceBinding");

export const removeOpenApiSourceBinding = OpenApiClient.mutation("openapi", "removeSourceBinding");

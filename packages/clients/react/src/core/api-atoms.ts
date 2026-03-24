import {
  Atom,
} from "@effect-atom/atom-react";
import type {
  InstanceConfig,
  LocalInstallation,
  SecretListItem,
} from "@executor/platform-api";
import type {
  Source,
  SourceInspection,
  SourceInspectionDiscoverResult,
  SourceInspectionToolDetail,
} from "@executor/platform-sdk/schema";
import * as Effect from "effect/Effect";

import { getExecutorApiBaseUrl } from "./base-url";
import { getExecutorApiHttpClient } from "./http-client";
import {
  instanceConfigReactivityKey,
  localInstallationReactivityKey,
  secretsReactivityKey,
  sourceDiscoveryReactivityKey,
  sourceInspectionReactivityKey,
  sourceInspectionToolReactivityKey,
  sourceReactivityKey,
  sourcesReactivityKey,
} from "./reactivity";
import { disabledAtom } from "./loadable";

export const localInstallationAtom = (baseUrl: string = getExecutorApiBaseUrl()) =>
  getExecutorApiHttpClient(baseUrl).query("local", "installation", {
    reactivityKeys: localInstallationReactivityKey(),
    timeToLive: "5 minutes",
  });

export const instanceConfigAtom = (baseUrl: string = getExecutorApiBaseUrl()) =>
  getExecutorApiHttpClient(baseUrl).query("local", "config", {
    reactivityKeys: instanceConfigReactivityKey(),
    timeToLive: "5 minutes",
  });

export const secretsAtom = (baseUrl: string = getExecutorApiBaseUrl()) =>
  getExecutorApiHttpClient(baseUrl).query("local", "listSecrets", {
    reactivityKeys: secretsReactivityKey(),
    timeToLive: "1 minute",
  });

export const sourcesAtom = (workspaceId: Source["scopeId"]) =>
  getExecutorApiHttpClient().query("sources", "list", {
    path: {
      workspaceId,
    },
    reactivityKeys: sourcesReactivityKey(workspaceId),
    timeToLive: "30 seconds",
  });

export const sourceAtom = (
  workspaceId: Source["scopeId"],
  sourceId: Source["id"],
) =>
  getExecutorApiHttpClient().query("sources", "get", {
    path: {
      workspaceId,
      sourceId,
    },
    reactivityKeys: sourceReactivityKey(workspaceId, sourceId),
    timeToLive: "30 seconds",
  });

export const sourceInspectionAtom = (
  workspaceId: Source["scopeId"],
  sourceId: Source["id"],
) =>
  getExecutorApiHttpClient().query("sources", "inspection", {
    path: {
      workspaceId,
      sourceId,
    },
    reactivityKeys: sourceInspectionReactivityKey(workspaceId, sourceId),
    timeToLive: "30 seconds",
  });

export const sourceInspectionToolAtom = (
  workspaceId: Source["scopeId"],
  sourceId: Source["id"],
  toolPath: string | null,
) =>
  toolPath === null
    ? disabledAtom<SourceInspectionToolDetail | null>()
    : getExecutorApiHttpClient().query("sources", "inspectionTool", {
        path: {
          workspaceId,
          sourceId,
          toolPath,
        },
        reactivityKeys: sourceInspectionToolReactivityKey(
          workspaceId,
          sourceId,
          toolPath,
        ),
        timeToLive: "30 seconds",
      });

const emptyDiscoveryResult: SourceInspectionDiscoverResult = {
  query: "",
  queryTokens: [],
  bestPath: null,
  total: 0,
  results: [],
};

export const sourceDiscoveryAtom = (
  workspaceId: Source["scopeId"],
  sourceId: Source["id"],
  query: string,
  limit: number | null,
) =>
  query.trim().length === 0
    ? Atom.make(
        Effect.succeed(emptyDiscoveryResult),
      ).pipe(Atom.keepAlive)
    : getExecutorApiHttpClient().query("sources", "inspectionDiscover", {
        path: {
          workspaceId,
          sourceId,
        },
        payload: {
          query,
          ...(limit !== null ? { limit } : {}),
        },
        reactivityKeys: sourceDiscoveryReactivityKey(
          workspaceId,
          sourceId,
          query,
          limit,
        ),
        timeToLive: "15 seconds",
      });

export type ExecutorApiAtoms = {
  localInstallationAtom: typeof localInstallationAtom;
  instanceConfigAtom: typeof instanceConfigAtom;
  secretsAtom: typeof secretsAtom;
  sourcesAtom: typeof sourcesAtom;
  sourceAtom: typeof sourceAtom;
  sourceInspectionAtom: typeof sourceInspectionAtom;
  sourceInspectionToolAtom: typeof sourceInspectionToolAtom;
  sourceDiscoveryAtom: typeof sourceDiscoveryAtom;
};

export type ExecutorApiAtomValues = {
  localInstallation: LocalInstallation;
  instanceConfig: InstanceConfig;
  secrets: ReadonlyArray<SecretListItem>;
  sources: ReadonlyArray<Source>;
  source: Source;
  sourceInspection: SourceInspection;
  sourceInspectionTool: SourceInspectionToolDetail | null;
  sourceDiscovery: SourceInspectionDiscoverResult;
};

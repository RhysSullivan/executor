import {
  ControlPlaneService,
  type ControlPlaneServiceShape,
} from "@executor-v2/management-api";
import * as Effect from "effect/Effect";

import { api } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { toSourceStoreError } from "./errors";

export const makeConvexControlPlaneService = (
  ctx: ActionCtx,
): ControlPlaneServiceShape =>
  ControlPlaneService.of({
    listSources: (workspaceId) =>
      Effect.tryPromise({
        try: () =>
          ctx.runQuery(api.controlPlane.listSources, {
            workspaceId,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.listSources", cause),
      }),
    upsertSource: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runAction(api.controlPlane.upsertSource, {
            workspaceId: input.workspaceId,
            payload: input.payload,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.upsertSource", cause),
      }),
    removeSource: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runMutation(api.controlPlane.removeSource, {
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.removeSource", cause),
      }),
    listCredentialBindings: (workspaceId) =>
      Effect.tryPromise({
        try: () =>
          ctx.runQuery(api.controlPlane.listCredentialBindings, {
            workspaceId,
          }),
        catch: (cause) =>
          toSourceStoreError("controlPlane.listCredentialBindings", cause),
      }),
    upsertCredentialBinding: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runAction(api.controlPlane.upsertCredentialBinding, {
            workspaceId: input.workspaceId,
            payload: input.payload,
          }),
        catch: (cause) =>
          toSourceStoreError("controlPlane.upsertCredentialBinding", cause),
      }),
    removeCredentialBinding: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runMutation(api.controlPlane.removeCredentialBinding, {
            workspaceId: input.workspaceId,
            credentialBindingId: input.credentialBindingId,
          }),
        catch: (cause) =>
          toSourceStoreError("controlPlane.removeCredentialBinding", cause),
      }),
    listPolicies: (workspaceId) =>
      Effect.tryPromise({
        try: () =>
          ctx.runQuery(api.controlPlane.listPolicies, {
            workspaceId,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.listPolicies", cause),
      }),
    upsertPolicy: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runMutation(api.controlPlane.upsertPolicy, {
            workspaceId: input.workspaceId,
            payload: input.payload,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.upsertPolicy", cause),
      }),
    removePolicy: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runMutation(api.controlPlane.removePolicy, {
            workspaceId: input.workspaceId,
            policyId: input.policyId,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.removePolicy", cause),
      }),
    listOrganizations: () =>
      Effect.tryPromise({
        try: () => ctx.runQuery(api.controlPlane.listOrganizations, {}),
        catch: (cause) => toSourceStoreError("controlPlane.listOrganizations", cause),
      }),
    upsertOrganization: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runMutation(api.controlPlane.upsertOrganization, {
            payload: input.payload,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.upsertOrganization", cause),
      }),
    listWorkspaces: () =>
      Effect.tryPromise({
        try: () => ctx.runQuery(api.controlPlane.listWorkspaces, {}),
        catch: (cause) => toSourceStoreError("controlPlane.listWorkspaces", cause),
      }),
    upsertWorkspace: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runMutation(api.controlPlane.upsertWorkspace, {
            payload: input.payload,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.upsertWorkspace", cause),
      }),
    listWorkspaceTools: (workspaceId) =>
      Effect.tryPromise({
        try: () =>
          ctx.runQuery(api.controlPlane.listWorkspaceTools, {
            workspaceId,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.listWorkspaceTools", cause),
      }),
    listSourceTools: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runQuery(api.controlPlane.listSourceTools, {
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.listSourceTools", cause),
      }),
    getToolDetail: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runQuery(api.controlPlane.getToolDetail, {
            workspaceId: input.workspaceId,
            sourceId: input.sourceId,
            operationHash: input.operationHash,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.getToolDetail", cause),
      }),
    listStorageInstances: (workspaceId) =>
      Effect.tryPromise({
        try: () =>
          ctx.runQuery(api.controlPlane.listStorageInstances, {
            workspaceId,
          }),
        catch: (cause) =>
          toSourceStoreError("controlPlane.listStorageInstances", cause),
      }),
    openStorageInstance: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runMutation(api.controlPlane.openStorageInstance, {
            workspaceId: input.workspaceId,
            payload: input.payload,
          }),
        catch: (cause) =>
          toSourceStoreError("controlPlane.openStorageInstance", cause),
      }),
    closeStorageInstance: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runMutation(api.controlPlane.closeStorageInstance, {
            workspaceId: input.workspaceId,
            storageInstanceId: input.storageInstanceId,
          }),
        catch: (cause) =>
          toSourceStoreError("controlPlane.closeStorageInstance", cause),
      }),
    removeStorageInstance: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runMutation(api.controlPlane.removeStorageInstance, {
            workspaceId: input.workspaceId,
            storageInstanceId: input.storageInstanceId,
          }),
        catch: (cause) =>
          toSourceStoreError("controlPlane.removeStorageInstance", cause),
      }),
    listStorageDirectory: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runQuery(api.controlPlane.listStorageDirectory, {
            workspaceId: input.workspaceId,
            storageInstanceId: input.storageInstanceId,
            payload: input.payload,
          }),
        catch: (cause) =>
          toSourceStoreError("controlPlane.listStorageDirectory", cause),
      }),
    readStorageFile: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runQuery(api.controlPlane.readStorageFile, {
            workspaceId: input.workspaceId,
            storageInstanceId: input.storageInstanceId,
            payload: input.payload,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.readStorageFile", cause),
      }),
    listStorageKv: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runQuery(api.controlPlane.listStorageKv, {
            workspaceId: input.workspaceId,
            storageInstanceId: input.storageInstanceId,
            payload: input.payload,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.listStorageKv", cause),
      }),
    queryStorageSql: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runMutation(api.controlPlane.queryStorageSql, {
            workspaceId: input.workspaceId,
            storageInstanceId: input.storageInstanceId,
            payload: input.payload,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.queryStorageSql", cause),
      }),
    listApprovals: (workspaceId) =>
      Effect.tryPromise({
        try: () =>
          ctx.runQuery(api.controlPlane.listApprovals, {
            workspaceId,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.listApprovals", cause),
      }),
    resolveApproval: (input) =>
      Effect.tryPromise({
        try: () =>
          ctx.runMutation(api.controlPlane.resolveApproval, {
            workspaceId: input.workspaceId,
            approvalId: input.approvalId,
            payload: input.payload,
          }),
        catch: (cause) => toSourceStoreError("controlPlane.resolveApproval", cause),
      }),
  });

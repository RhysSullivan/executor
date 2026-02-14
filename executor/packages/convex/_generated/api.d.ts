/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";
import type { GenericId as Id } from "convex/values";

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: {
  accounts: {
    deleteCurrentAccount: FunctionReference<
      "mutation",
      "public",
      { sessionId?: string },
      any
    >;
  };
  app: {
    getClientConfig: FunctionReference<"query", "public", {}, any>;
    getCurrentAccount: FunctionReference<
      "query",
      "public",
      { sessionId?: string },
      any
    >;
  };
  auth: {
    bootstrapCurrentWorkosAccount: FunctionReference<
      "mutation",
      "public",
      {},
      any
    >;
  };
  billing: {
    createCustomerPortal: FunctionReference<
      "action",
      "public",
      {
        organizationId: Id<"organizations">;
        returnUrl?: string;
        sessionId?: string;
      },
      { url: string }
    >;
    createSubscriptionCheckout: FunctionReference<
      "action",
      "public",
      {
        cancelUrl?: string;
        organizationId: Id<"organizations">;
        priceId: string;
        sessionId?: string;
        successUrl?: string;
      },
      any
    >;
    getSummary: FunctionReference<
      "query",
      "public",
      { organizationId: Id<"organizations">; sessionId?: string },
      any
    >;
    retrySeatSync: FunctionReference<
      "mutation",
      "public",
      { organizationId: Id<"organizations">; sessionId?: string },
      any
    >;
  };
  credentialsNode: {
    upsertCredential: FunctionReference<
      "action",
      "public",
      {
        actorId?: string;
        id?: string;
        provider?: "local-convex" | "workos-vault";
        scope: "workspace" | "actor";
        secretJson: any;
        sessionId?: string;
        sourceKey: string;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
  };
  executor: {
    createTask: FunctionReference<
      "action",
      "public",
      {
        actorId?: string;
        clientId?: string;
        code: string;
        metadata?: any;
        runtimeId?: string;
        sessionId?: string;
        timeoutMs?: number;
        waitForResult?: boolean;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
    resolveApproval: FunctionReference<
      "mutation",
      "public",
      {
        approvalId: string;
        decision: "approved" | "denied";
        reason?: string;
        reviewerId?: string;
        sessionId?: string;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
  };
  executorNode: {
    listToolDtsUrls: FunctionReference<
      "action",
      "public",
      { actorId?: string; sessionId?: string; workspaceId: Id<"workspaces"> },
      any
    >;
    listToolsWithWarnings: FunctionReference<
      "action",
      "public",
      {
        actorId?: string;
        clientId?: string;
        includeDetails?: boolean;
        includeSchemaRegistry?: boolean;
        includeSourceMeta?: boolean;
        sessionId?: string;
        toolPaths?: Array<string>;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
  };
  invites: {
    create: FunctionReference<
      "mutation",
      "public",
      {
        email: string;
        expiresInDays?: number;
        organizationId: Id<"organizations">;
        role: "owner" | "admin" | "member" | "billing_admin";
        sessionId?: string;
        workspaceId?: Id<"workspaces">;
      },
      any
    >;
    list: FunctionReference<
      "query",
      "public",
      { organizationId: Id<"organizations">; sessionId?: string },
      any
    >;
    revoke: FunctionReference<
      "mutation",
      "public",
      {
        inviteId: Id<"invites">;
        organizationId: Id<"organizations">;
        sessionId?: string;
      },
      any
    >;
  };
  organizationMembers: {
    list: FunctionReference<
      "query",
      "public",
      { organizationId: Id<"organizations">; sessionId?: string },
      any
    >;
    remove: FunctionReference<
      "mutation",
      "public",
      {
        accountId: Id<"accounts">;
        organizationId: Id<"organizations">;
        sessionId?: string;
      },
      any
    >;
    updateBillable: FunctionReference<
      "mutation",
      "public",
      {
        accountId: Id<"accounts">;
        billable: boolean;
        organizationId: Id<"organizations">;
        sessionId?: string;
      },
      any
    >;
    updateRole: FunctionReference<
      "mutation",
      "public",
      {
        accountId: Id<"accounts">;
        organizationId: Id<"organizations">;
        role: "owner" | "admin" | "member" | "billing_admin";
        sessionId?: string;
      },
      any
    >;
  };
  organizations: {
    create: FunctionReference<
      "mutation",
      "public",
      { name: string; sessionId?: string },
      any
    >;
    getNavigationState: FunctionReference<
      "query",
      "public",
      { sessionId?: string },
      any
    >;
    getOrganizationAccess: FunctionReference<
      "query",
      "public",
      { organizationId: Id<"organizations">; sessionId?: string },
      any
    >;
    listMine: FunctionReference<"query", "public", { sessionId?: string }, any>;
    resolveWorkosOrganizationId: FunctionReference<
      "query",
      "public",
      { organizationId: Id<"organizations">; sessionId?: string },
      any
    >;
  };
  runtimeCallbacks: {
    completeRun: FunctionReference<
      "mutation",
      "public",
      {
        durationMs?: number;
        error?: string;
        exitCode?: number;
        internalSecret: string;
        runId: string;
        status: "completed" | "failed" | "timed_out" | "denied";
      },
      any
    >;
    getApprovalStatus: FunctionReference<
      "query",
      "public",
      { approvalId: string; internalSecret: string; runId: string },
      any
    >;
    handleToolCall: FunctionReference<
      "action",
      "public",
      {
        callId: string;
        input?: any;
        internalSecret: string;
        runId: string;
        toolPath: string;
      },
      any
    >;
  };
  workspace: {
    bootstrapAnonymousSession: FunctionReference<
      "mutation",
      "public",
      { sessionId?: string },
      any
    >;
    deleteToolSource: FunctionReference<
      "mutation",
      "public",
      { sessionId?: string; sourceId: string; workspaceId: Id<"workspaces"> },
      any
    >;
    getTaskInWorkspace: FunctionReference<
      "query",
      "public",
      { sessionId?: string; taskId: string; workspaceId: Id<"workspaces"> },
      any
    >;
    listAccessPolicies: FunctionReference<
      "query",
      "public",
      { sessionId?: string; workspaceId: Id<"workspaces"> },
      any
    >;
    listCredentialProviders: FunctionReference<"query", "public", {}, any>;
    listCredentials: FunctionReference<
      "query",
      "public",
      { sessionId?: string; workspaceId: Id<"workspaces"> },
      any
    >;
    listPendingApprovals: FunctionReference<
      "query",
      "public",
      { sessionId?: string; workspaceId: Id<"workspaces"> },
      any
    >;
    listRuntimeTargets: FunctionReference<"query", "public", {}, any>;
    listTaskEvents: FunctionReference<
      "query",
      "public",
      { sessionId?: string; taskId: string; workspaceId: Id<"workspaces"> },
      any
    >;
    listTasks: FunctionReference<
      "query",
      "public",
      { sessionId?: string; workspaceId: Id<"workspaces"> },
      any
    >;
    listToolSources: FunctionReference<
      "query",
      "public",
      { sessionId?: string; workspaceId: Id<"workspaces"> },
      any
    >;
    resolveCredential: FunctionReference<
      "query",
      "public",
      {
        actorId?: string;
        scope: "workspace" | "actor";
        sessionId?: string;
        sourceKey: string;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
    upsertAccessPolicy: FunctionReference<
      "mutation",
      "public",
      {
        actorId?: string;
        clientId?: string;
        decision: "allow" | "require_approval" | "deny";
        id?: string;
        priority?: number;
        sessionId?: string;
        toolPathPattern: string;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
    upsertCredential: FunctionReference<
      "mutation",
      "public",
      {
        actorId?: string;
        id?: string;
        overridesJson?: any;
        provider?: "local-convex" | "workos-vault";
        scope: "workspace" | "actor";
        secretJson: any;
        sessionId?: string;
        sourceKey: string;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
    upsertToolSource: FunctionReference<
      "mutation",
      "public",
      {
        config: any;
        enabled?: boolean;
        id?: string;
        name: string;
        sessionId?: string;
        type: "mcp" | "openapi" | "graphql";
        workspaceId: Id<"workspaces">;
      },
      any
    >;
  };
  workspaces: {
    create: FunctionReference<
      "mutation",
      "public",
      {
        iconStorageId?: Id<"_storage">;
        name: string;
        organizationId?: Id<"organizations">;
        sessionId?: string;
      },
      any
    >;
    generateWorkspaceIconUploadUrl: FunctionReference<
      "mutation",
      "public",
      { sessionId?: string },
      any
    >;
    list: FunctionReference<
      "query",
      "public",
      { organizationId?: Id<"organizations">; sessionId?: string },
      any
    >;
  };
};

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: {
  auth: {
    authKitEvent: FunctionReference<
      "mutation",
      "internal",
      { data: Record<string, any>; event: string },
      null
    >;
  };
  billingInternal: {
    bumpSeatSyncVersion: FunctionReference<
      "mutation",
      "internal",
      { organizationId: Id<"organizations"> },
      any
    >;
    getBillingAccessForRequest: FunctionReference<
      "query",
      "internal",
      { organizationId: Id<"organizations">; sessionId?: string },
      any
    >;
    getSeatSyncSnapshot: FunctionReference<
      "query",
      "internal",
      { organizationId: Id<"organizations"> },
      any
    >;
    upsertCustomerLink: FunctionReference<
      "mutation",
      "internal",
      { organizationId: Id<"organizations">; stripeCustomerId: string },
      any
    >;
    upsertSeatState: FunctionReference<
      "mutation",
      "internal",
      {
        bumpVersion: boolean;
        desiredSeats: number;
        lastAppliedSeats: number | null;
        organizationId: Id<"organizations">;
        syncError: string | null;
      },
      any
    >;
  };
  billingSync: {
    syncSeatQuantity: FunctionReference<
      "action",
      "internal",
      { expectedVersion: number; organizationId: Id<"organizations"> },
      any
    >;
  };
  database: {
    anonymous_session: {
      bootstrapAnonymousSession: FunctionReference<
        "mutation",
        "internal",
        { actorId?: string; clientId?: string; sessionId?: string },
        any
      >;
      ensureAnonymousMcpSession: FunctionReference<
        "mutation",
        "internal",
        { actorId: string; workspaceId: Id<"workspaces"> },
        any
      >;
    };
    approvals: {
      createApproval: FunctionReference<
        "mutation",
        "internal",
        { id: string; input?: any; taskId: string; toolPath: string },
        any
      >;
      getApproval: FunctionReference<
        "query",
        "internal",
        { approvalId: string },
        any
      >;
      getApprovalInWorkspace: FunctionReference<
        "query",
        "internal",
        { approvalId: string; workspaceId: Id<"workspaces"> },
        any
      >;
      listApprovals: FunctionReference<
        "query",
        "internal",
        {
          status?: "pending" | "approved" | "denied";
          workspaceId: Id<"workspaces">;
        },
        any
      >;
      listPendingApprovals: FunctionReference<
        "query",
        "internal",
        { workspaceId: Id<"workspaces"> },
        any
      >;
      resolveApproval: FunctionReference<
        "mutation",
        "internal",
        {
          approvalId: string;
          decision: "approved" | "denied";
          reason?: string;
          reviewerId?: string;
        },
        any
      >;
    };
    bootstrapAnonymousSession: FunctionReference<
      "mutation",
      "internal",
      { actorId?: string; clientId?: string; sessionId?: string },
      any
    >;
    createApproval: FunctionReference<
      "mutation",
      "internal",
      { id: string; input?: any; taskId: string; toolPath: string },
      any
    >;
    createTask: FunctionReference<
      "mutation",
      "internal",
      {
        actorId: string;
        clientId?: string;
        code: string;
        id: string;
        metadata?: any;
        runtimeId: string;
        timeoutMs?: number;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
    createTaskEvent: FunctionReference<
      "mutation",
      "internal",
      { eventName: string; payload: any; taskId: string; type: string },
      any
    >;
    credentials: {
      listCredentialProviders: FunctionReference<"query", "internal", {}, any>;
      listCredentials: FunctionReference<
        "query",
        "internal",
        { workspaceId: Id<"workspaces"> },
        any
      >;
      resolveCredential: FunctionReference<
        "query",
        "internal",
        {
          actorId?: string;
          scope: "workspace" | "actor";
          sourceKey: string;
          workspaceId: Id<"workspaces">;
        },
        any
      >;
      upsertCredential: FunctionReference<
        "mutation",
        "internal",
        {
          actorId?: string;
          id?: string;
          overridesJson?: any;
          provider?: "local-convex" | "workos-vault";
          scope: "workspace" | "actor";
          secretJson: any;
          sourceKey: string;
          workspaceId: Id<"workspaces">;
        },
        any
      >;
    };
    deleteToolSource: FunctionReference<
      "mutation",
      "internal",
      { sourceId: string; workspaceId: Id<"workspaces"> },
      any
    >;
    ensureAnonymousMcpSession: FunctionReference<
      "mutation",
      "internal",
      { actorId: string; workspaceId: Id<"workspaces"> },
      any
    >;
    finishToolCall: FunctionReference<
      "mutation",
      "internal",
      {
        callId: string;
        error?: string;
        status: "completed" | "failed" | "denied";
        taskId: string;
      },
      any
    >;
    getApproval: FunctionReference<
      "query",
      "internal",
      { approvalId: string },
      any
    >;
    getApprovalInWorkspace: FunctionReference<
      "query",
      "internal",
      { approvalId: string; workspaceId: Id<"workspaces"> },
      any
    >;
    getTask: FunctionReference<"query", "internal", { taskId: string }, any>;
    getTaskInWorkspace: FunctionReference<
      "query",
      "internal",
      { taskId: string; workspaceId: Id<"workspaces"> },
      any
    >;
    getToolCall: FunctionReference<
      "query",
      "internal",
      { callId: string; taskId: string },
      any
    >;
    listAccessPolicies: FunctionReference<
      "query",
      "internal",
      { workspaceId: Id<"workspaces"> },
      any
    >;
    listApprovals: FunctionReference<
      "query",
      "internal",
      {
        status?: "pending" | "approved" | "denied";
        workspaceId: Id<"workspaces">;
      },
      any
    >;
    listCredentialProviders: FunctionReference<"query", "internal", {}, any>;
    listCredentials: FunctionReference<
      "query",
      "internal",
      { workspaceId: Id<"workspaces"> },
      any
    >;
    listPendingApprovals: FunctionReference<
      "query",
      "internal",
      { workspaceId: Id<"workspaces"> },
      any
    >;
    listQueuedTaskIds: FunctionReference<
      "query",
      "internal",
      { limit?: number },
      any
    >;
    listRuntimeTargets: FunctionReference<"query", "internal", {}, any>;
    listTaskEvents: FunctionReference<
      "query",
      "internal",
      { taskId: string },
      any
    >;
    listTasks: FunctionReference<
      "query",
      "internal",
      { workspaceId: Id<"workspaces"> },
      any
    >;
    listToolCalls: FunctionReference<
      "query",
      "internal",
      { taskId: string },
      any
    >;
    listToolSources: FunctionReference<
      "query",
      "internal",
      { workspaceId: Id<"workspaces"> },
      any
    >;
    markTaskFinished: FunctionReference<
      "mutation",
      "internal",
      {
        error?: string;
        exitCode?: number;
        status: "completed" | "failed" | "timed_out" | "denied";
        taskId: string;
      },
      any
    >;
    markTaskRunning: FunctionReference<
      "mutation",
      "internal",
      { taskId: string },
      any
    >;
    policies: {
      listAccessPolicies: FunctionReference<
        "query",
        "internal",
        { workspaceId: Id<"workspaces"> },
        any
      >;
      listRuntimeTargets: FunctionReference<"query", "internal", {}, any>;
      upsertAccessPolicy: FunctionReference<
        "mutation",
        "internal",
        {
          actorId?: string;
          clientId?: string;
          decision: "allow" | "require_approval" | "deny";
          id?: string;
          priority?: number;
          toolPathPattern: string;
          workspaceId: Id<"workspaces">;
        },
        any
      >;
    };
    resolveApproval: FunctionReference<
      "mutation",
      "internal",
      {
        approvalId: string;
        decision: "approved" | "denied";
        reason?: string;
        reviewerId?: string;
      },
      any
    >;
    resolveCredential: FunctionReference<
      "query",
      "internal",
      {
        actorId?: string;
        scope: "workspace" | "actor";
        sourceKey: string;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
    setToolCallPendingApproval: FunctionReference<
      "mutation",
      "internal",
      { approvalId: string; callId: string; taskId: string },
      any
    >;
    task_events: {
      createTaskEvent: FunctionReference<
        "mutation",
        "internal",
        { eventName: string; payload: any; taskId: string; type: string },
        any
      >;
      listTaskEvents: FunctionReference<
        "query",
        "internal",
        { taskId: string },
        any
      >;
    };
    tasks: {
      createTask: FunctionReference<
        "mutation",
        "internal",
        {
          actorId: string;
          clientId?: string;
          code: string;
          id: string;
          metadata?: any;
          runtimeId: string;
          timeoutMs?: number;
          workspaceId: Id<"workspaces">;
        },
        any
      >;
      getTask: FunctionReference<"query", "internal", { taskId: string }, any>;
      getTaskInWorkspace: FunctionReference<
        "query",
        "internal",
        { taskId: string; workspaceId: Id<"workspaces"> },
        any
      >;
      listQueuedTaskIds: FunctionReference<
        "query",
        "internal",
        { limit?: number },
        any
      >;
      listTasks: FunctionReference<
        "query",
        "internal",
        { workspaceId: Id<"workspaces"> },
        any
      >;
      markTaskFinished: FunctionReference<
        "mutation",
        "internal",
        {
          error?: string;
          exitCode?: number;
          status: "completed" | "failed" | "timed_out" | "denied";
          taskId: string;
        },
        any
      >;
      markTaskRunning: FunctionReference<
        "mutation",
        "internal",
        { taskId: string },
        any
      >;
    };
    tool_calls: {
      finishToolCall: FunctionReference<
        "mutation",
        "internal",
        {
          callId: string;
          error?: string;
          status: "completed" | "failed" | "denied";
          taskId: string;
        },
        any
      >;
      getToolCall: FunctionReference<
        "query",
        "internal",
        { callId: string; taskId: string },
        any
      >;
      listToolCalls: FunctionReference<
        "query",
        "internal",
        { taskId: string },
        any
      >;
      setToolCallPendingApproval: FunctionReference<
        "mutation",
        "internal",
        { approvalId: string; callId: string; taskId: string },
        any
      >;
      upsertToolCallRequested: FunctionReference<
        "mutation",
        "internal",
        {
          callId: string;
          taskId: string;
          toolPath: string;
          workspaceId: Id<"workspaces">;
        },
        any
      >;
    };
    tool_sources: {
      deleteToolSource: FunctionReference<
        "mutation",
        "internal",
        { sourceId: string; workspaceId: Id<"workspaces"> },
        any
      >;
      listToolSources: FunctionReference<
        "query",
        "internal",
        { workspaceId: Id<"workspaces"> },
        any
      >;
      upsertToolSource: FunctionReference<
        "mutation",
        "internal",
        {
          config: any;
          enabled?: boolean;
          id?: string;
          name: string;
          type: "mcp" | "openapi" | "graphql";
          workspaceId: Id<"workspaces">;
        },
        any
      >;
    };
    upsertAccessPolicy: FunctionReference<
      "mutation",
      "internal",
      {
        actorId?: string;
        clientId?: string;
        decision: "allow" | "require_approval" | "deny";
        id?: string;
        priority?: number;
        toolPathPattern: string;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
    upsertCredential: FunctionReference<
      "mutation",
      "internal",
      {
        actorId?: string;
        id?: string;
        overridesJson?: any;
        provider?: "local-convex" | "workos-vault";
        scope: "workspace" | "actor";
        secretJson: any;
        sourceKey: string;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
    upsertToolCallRequested: FunctionReference<
      "mutation",
      "internal",
      {
        callId: string;
        taskId: string;
        toolPath: string;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
    upsertToolSource: FunctionReference<
      "mutation",
      "internal",
      {
        config: any;
        enabled?: boolean;
        id?: string;
        name: string;
        type: "mcp" | "openapi" | "graphql";
        workspaceId: Id<"workspaces">;
      },
      any
    >;
  };
  executor: {
    completeRuntimeRun: FunctionReference<
      "mutation",
      "internal",
      {
        durationMs?: number;
        error?: string;
        exitCode?: number;
        runId: string;
        status: "completed" | "failed" | "timed_out" | "denied";
      },
      any
    >;
    createTaskInternal: FunctionReference<
      "mutation",
      "internal",
      {
        actorId: string;
        clientId?: string;
        code: string;
        metadata?: any;
        runtimeId?: string;
        scheduleAfterCreate?: boolean;
        timeoutMs?: number;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
    resolveApprovalInternal: FunctionReference<
      "mutation",
      "internal",
      {
        approvalId: string;
        decision: "approved" | "denied";
        reason?: string;
        reviewerId?: string;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
  };
  executorNode: {
    handleExternalToolCall: FunctionReference<
      "action",
      "internal",
      { callId: string; input?: any; runId: string; toolPath: string },
      any
    >;
    listToolsInternal: FunctionReference<
      "action",
      "internal",
      { actorId?: string; clientId?: string; workspaceId: Id<"workspaces"> },
      any
    >;
    listToolsWithWarningsInternal: FunctionReference<
      "action",
      "internal",
      { actorId?: string; clientId?: string; workspaceId: Id<"workspaces"> },
      any
    >;
    runTask: FunctionReference<"action", "internal", { taskId: string }, any>;
  };
  invites: {
    deliverWorkosInvite: FunctionReference<
      "action",
      "internal",
      {
        expiresInDays?: number;
        inviteId: Id<"invites">;
        inviterWorkosUserId: string;
        roleSlug?: string;
      },
      any
    >;
    getInviteById: FunctionReference<
      "query",
      "internal",
      { inviteId: Id<"invites"> },
      any
    >;
    getInviteDeliveryContext: FunctionReference<
      "query",
      "internal",
      { inviteId: Id<"invites"> },
      any
    >;
    linkOrganizationToWorkos: FunctionReference<
      "mutation",
      "internal",
      {
        organizationId: Id<"organizations">;
        workosOrgId: string;
        workspaceId?: Id<"workspaces">;
      },
      any
    >;
    markInviteDelivered: FunctionReference<
      "mutation",
      "internal",
      { inviteId: Id<"invites">; providerInviteId: string },
      any
    >;
    markInviteDeliveryFailed: FunctionReference<
      "mutation",
      "internal",
      { errorMessage: string; inviteId: Id<"invites"> },
      any
    >;
    revokeWorkosInvite: FunctionReference<
      "action",
      "internal",
      { inviteId: Id<"invites">; providerInviteId: string },
      any
    >;
  };
  migrations: {
    backfillDtsStorageIds: FunctionReference<
      "mutation",
      "internal",
      {
        batchSize?: number;
        cursor?: string | null;
        dryRun?: boolean;
        fn?: string;
        next?: Array<string>;
      },
      any
    >;
    cleanupAccessPolicyEmptyStringSentinels: FunctionReference<
      "mutation",
      "internal",
      {
        batchSize?: number;
        cursor?: string | null;
        dryRun?: boolean;
        fn?: string;
        next?: Array<string>;
      },
      any
    >;
    cleanupTaskEmptyStringSentinels: FunctionReference<
      "mutation",
      "internal",
      {
        batchSize?: number;
        cursor?: string | null;
        dryRun?: boolean;
        fn?: string;
        next?: Array<string>;
      },
      any
    >;
    deleteAnonymousSessionsMissingAccountId: FunctionReference<
      "mutation",
      "internal",
      {
        batchSize?: number;
        cursor?: string | null;
        dryRun?: boolean;
        fn?: string;
        next?: Array<string>;
      },
      any
    >;
    deleteAnonymousSessionsMissingUserId: FunctionReference<
      "mutation",
      "internal",
      {
        batchSize?: number;
        cursor?: string | null;
        dryRun?: boolean;
        fn?: string;
        next?: Array<string>;
      },
      any
    >;
    deleteSourceCredentialsMissingProvider: FunctionReference<
      "mutation",
      "internal",
      {
        batchSize?: number;
        cursor?: string | null;
        dryRun?: boolean;
        fn?: string;
        next?: Array<string>;
      },
      any
    >;
    renameLegacyAnonymousOrganizations: FunctionReference<
      "mutation",
      "internal",
      {
        batchSize?: number;
        cursor?: string | null;
        dryRun?: boolean;
        fn?: string;
        next?: Array<string>;
      },
      any
    >;
    renameLegacyAnonymousWorkspaces: FunctionReference<
      "mutation",
      "internal",
      {
        batchSize?: number;
        cursor?: string | null;
        dryRun?: boolean;
        fn?: string;
        next?: Array<string>;
      },
      any
    >;
    run: FunctionReference<
      "mutation",
      "internal",
      {
        batchSize?: number;
        cursor?: string | null;
        dryRun?: boolean;
        fn?: string;
        next?: Array<string>;
      },
      any
    >;
  };
  openApiSpecCache: {
    getEntry: FunctionReference<
      "query",
      "internal",
      { maxAgeMs: number; specUrl: string; version: string },
      any
    >;
    putEntry: FunctionReference<
      "mutation",
      "internal",
      {
        sizeBytes: number;
        specUrl: string;
        storageId: Id<"_storage">;
        version: string;
      },
      any
    >;
  };
  workspaceAuthInternal: {
    getWorkspaceAccessForAnonymousSubject: FunctionReference<
      "query",
      "internal",
      { actorId: string; workspaceId: Id<"workspaces"> },
      any
    >;
    getWorkspaceAccessForRequest: FunctionReference<
      "query",
      "internal",
      { sessionId?: string; workspaceId: Id<"workspaces"> },
      any
    >;
    getWorkspaceAccessForWorkosSubject: FunctionReference<
      "query",
      "internal",
      { subject: string; workspaceId: Id<"workspaces"> },
      any
    >;
  };
  workspaceToolCache: {
    getEntry: FunctionReference<
      "query",
      "internal",
      { signature: string; workspaceId: Id<"workspaces"> },
      any
    >;
    putEntry: FunctionReference<
      "mutation",
      "internal",
      {
        dtsStorageIds: Array<{ sourceKey: string; storageId: Id<"_storage"> }>;
        signature: string;
        sizeBytes: number;
        storageId: Id<"_storage">;
        toolCount: number;
        workspaceId: Id<"workspaces">;
      },
      any
    >;
  };
};

export declare const components: {
  workOSAuthKit: {
    lib: {
      enqueueWebhookEvent: FunctionReference<
        "mutation",
        "internal",
        {
          apiKey: string;
          event: string;
          eventId: string;
          eventTypes?: Array<string>;
          logLevel?: "DEBUG";
          onEventHandle?: string;
          updatedAt?: string;
        },
        any
      >;
      getAuthUser: FunctionReference<
        "query",
        "internal",
        { id: string },
        {
          createdAt: string;
          email: string;
          emailVerified: boolean;
          externalId?: null | string;
          firstName?: null | string;
          id: string;
          lastName?: null | string;
          lastSignInAt?: null | string;
          locale?: null | string;
          metadata: Record<string, any>;
          profilePictureUrl?: null | string;
          updatedAt: string;
        } | null
      >;
    };
  };
  stripe: {
    private: {
      handleCheckoutSessionCompleted: FunctionReference<
        "mutation",
        "internal",
        {
          metadata?: any;
          mode: string;
          stripeCheckoutSessionId: string;
          stripeCustomerId?: string;
        },
        null
      >;
      handleCustomerCreated: FunctionReference<
        "mutation",
        "internal",
        {
          email?: string;
          metadata?: any;
          name?: string;
          stripeCustomerId: string;
        },
        null
      >;
      handleCustomerUpdated: FunctionReference<
        "mutation",
        "internal",
        {
          email?: string;
          metadata?: any;
          name?: string;
          stripeCustomerId: string;
        },
        null
      >;
      handleInvoiceCreated: FunctionReference<
        "mutation",
        "internal",
        {
          amountDue: number;
          amountPaid: number;
          created: number;
          status: string;
          stripeCustomerId: string;
          stripeInvoiceId: string;
          stripeSubscriptionId?: string;
        },
        null
      >;
      handleInvoicePaid: FunctionReference<
        "mutation",
        "internal",
        { amountPaid: number; stripeInvoiceId: string },
        null
      >;
      handleInvoicePaymentFailed: FunctionReference<
        "mutation",
        "internal",
        { stripeInvoiceId: string },
        null
      >;
      handlePaymentIntentSucceeded: FunctionReference<
        "mutation",
        "internal",
        {
          amount: number;
          created: number;
          currency: string;
          metadata?: any;
          status: string;
          stripeCustomerId?: string;
          stripePaymentIntentId: string;
        },
        null
      >;
      handleSubscriptionCreated: FunctionReference<
        "mutation",
        "internal",
        {
          cancelAt?: number;
          cancelAtPeriodEnd: boolean;
          currentPeriodEnd: number;
          metadata?: any;
          priceId: string;
          quantity?: number;
          status: string;
          stripeCustomerId: string;
          stripeSubscriptionId: string;
        },
        null
      >;
      handleSubscriptionDeleted: FunctionReference<
        "mutation",
        "internal",
        { stripeSubscriptionId: string },
        null
      >;
      handleSubscriptionUpdated: FunctionReference<
        "mutation",
        "internal",
        {
          cancelAt?: number;
          cancelAtPeriodEnd: boolean;
          currentPeriodEnd: number;
          metadata?: any;
          priceId?: string;
          quantity?: number;
          status: string;
          stripeSubscriptionId: string;
        },
        null
      >;
      updatePaymentCustomer: FunctionReference<
        "mutation",
        "internal",
        { stripeCustomerId: string; stripePaymentIntentId: string },
        null
      >;
      updateSubscriptionQuantityInternal: FunctionReference<
        "mutation",
        "internal",
        { quantity: number; stripeSubscriptionId: string },
        null
      >;
    };
    public: {
      createOrUpdateCustomer: FunctionReference<
        "mutation",
        "internal",
        {
          email?: string;
          metadata?: any;
          name?: string;
          stripeCustomerId: string;
        },
        string
      >;
      getCustomer: FunctionReference<
        "query",
        "internal",
        { stripeCustomerId: string },
        {
          email?: string;
          metadata?: any;
          name?: string;
          stripeCustomerId: string;
        } | null
      >;
      getPayment: FunctionReference<
        "query",
        "internal",
        { stripePaymentIntentId: string },
        {
          amount: number;
          created: number;
          currency: string;
          metadata?: any;
          orgId?: string;
          status: string;
          stripeCustomerId?: string;
          stripePaymentIntentId: string;
          userId?: string;
        } | null
      >;
      getSubscription: FunctionReference<
        "query",
        "internal",
        { stripeSubscriptionId: string },
        {
          cancelAt?: number;
          cancelAtPeriodEnd: boolean;
          currentPeriodEnd: number;
          metadata?: any;
          orgId?: string;
          priceId: string;
          quantity?: number;
          status: string;
          stripeCustomerId: string;
          stripeSubscriptionId: string;
          userId?: string;
        } | null
      >;
      getSubscriptionByOrgId: FunctionReference<
        "query",
        "internal",
        { orgId: string },
        {
          cancelAt?: number;
          cancelAtPeriodEnd: boolean;
          currentPeriodEnd: number;
          metadata?: any;
          orgId?: string;
          priceId: string;
          quantity?: number;
          status: string;
          stripeCustomerId: string;
          stripeSubscriptionId: string;
          userId?: string;
        } | null
      >;
      listInvoices: FunctionReference<
        "query",
        "internal",
        { stripeCustomerId: string },
        Array<{
          amountDue: number;
          amountPaid: number;
          created: number;
          orgId?: string;
          status: string;
          stripeCustomerId: string;
          stripeInvoiceId: string;
          stripeSubscriptionId?: string;
          userId?: string;
        }>
      >;
      listInvoicesByOrgId: FunctionReference<
        "query",
        "internal",
        { orgId: string },
        Array<{
          amountDue: number;
          amountPaid: number;
          created: number;
          orgId?: string;
          status: string;
          stripeCustomerId: string;
          stripeInvoiceId: string;
          stripeSubscriptionId?: string;
          userId?: string;
        }>
      >;
      listInvoicesByUserId: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{
          amountDue: number;
          amountPaid: number;
          created: number;
          orgId?: string;
          status: string;
          stripeCustomerId: string;
          stripeInvoiceId: string;
          stripeSubscriptionId?: string;
          userId?: string;
        }>
      >;
      listPayments: FunctionReference<
        "query",
        "internal",
        { stripeCustomerId: string },
        Array<{
          amount: number;
          created: number;
          currency: string;
          metadata?: any;
          orgId?: string;
          status: string;
          stripeCustomerId?: string;
          stripePaymentIntentId: string;
          userId?: string;
        }>
      >;
      listPaymentsByOrgId: FunctionReference<
        "query",
        "internal",
        { orgId: string },
        Array<{
          amount: number;
          created: number;
          currency: string;
          metadata?: any;
          orgId?: string;
          status: string;
          stripeCustomerId?: string;
          stripePaymentIntentId: string;
          userId?: string;
        }>
      >;
      listPaymentsByUserId: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{
          amount: number;
          created: number;
          currency: string;
          metadata?: any;
          orgId?: string;
          status: string;
          stripeCustomerId?: string;
          stripePaymentIntentId: string;
          userId?: string;
        }>
      >;
      listSubscriptions: FunctionReference<
        "query",
        "internal",
        { stripeCustomerId: string },
        Array<{
          cancelAt?: number;
          cancelAtPeriodEnd: boolean;
          currentPeriodEnd: number;
          metadata?: any;
          orgId?: string;
          priceId: string;
          quantity?: number;
          status: string;
          stripeCustomerId: string;
          stripeSubscriptionId: string;
          userId?: string;
        }>
      >;
      listSubscriptionsByUserId: FunctionReference<
        "query",
        "internal",
        { userId: string },
        Array<{
          cancelAt?: number;
          cancelAtPeriodEnd: boolean;
          currentPeriodEnd: number;
          metadata?: any;
          orgId?: string;
          priceId: string;
          quantity?: number;
          status: string;
          stripeCustomerId: string;
          stripeSubscriptionId: string;
          userId?: string;
        }>
      >;
      updateSubscriptionMetadata: FunctionReference<
        "mutation",
        "internal",
        {
          metadata: any;
          orgId?: string;
          stripeSubscriptionId: string;
          userId?: string;
        },
        null
      >;
      updateSubscriptionQuantity: FunctionReference<
        "action",
        "internal",
        { apiKey: string; quantity: number; stripeSubscriptionId: string },
        null
      >;
    };
  };
  migrations: {
    lib: {
      cancel: FunctionReference<
        "mutation",
        "internal",
        { name: string },
        {
          batchSize?: number;
          cursor?: string | null;
          error?: string;
          isDone: boolean;
          latestEnd?: number;
          latestStart: number;
          name: string;
          next?: Array<string>;
          processed: number;
          state: "inProgress" | "success" | "failed" | "canceled" | "unknown";
        }
      >;
      cancelAll: FunctionReference<
        "mutation",
        "internal",
        { sinceTs?: number },
        Array<{
          batchSize?: number;
          cursor?: string | null;
          error?: string;
          isDone: boolean;
          latestEnd?: number;
          latestStart: number;
          name: string;
          next?: Array<string>;
          processed: number;
          state: "inProgress" | "success" | "failed" | "canceled" | "unknown";
        }>
      >;
      clearAll: FunctionReference<
        "mutation",
        "internal",
        { before?: number },
        null
      >;
      getStatus: FunctionReference<
        "query",
        "internal",
        { limit?: number; names?: Array<string> },
        Array<{
          batchSize?: number;
          cursor?: string | null;
          error?: string;
          isDone: boolean;
          latestEnd?: number;
          latestStart: number;
          name: string;
          next?: Array<string>;
          processed: number;
          state: "inProgress" | "success" | "failed" | "canceled" | "unknown";
        }>
      >;
      migrate: FunctionReference<
        "mutation",
        "internal",
        {
          batchSize?: number;
          cursor?: string | null;
          dryRun: boolean;
          fnHandle: string;
          name: string;
          next?: Array<{ fnHandle: string; name: string }>;
          oneBatchOnly?: boolean;
        },
        {
          batchSize?: number;
          cursor?: string | null;
          error?: string;
          isDone: boolean;
          latestEnd?: number;
          latestStart: number;
          name: string;
          next?: Array<string>;
          processed: number;
          state: "inProgress" | "success" | "failed" | "canceled" | "unknown";
        }
      >;
    };
  };
};

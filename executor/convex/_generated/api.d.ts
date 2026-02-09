/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 *
 * NOTE: This file has been post-processed by scripts/postcodegen.ts
 * to replace recursive ApiFromModules/FilterApi types with explicit
 * declarations, avoiding TS2589 depth errors.
 *
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: {
  app: {
    getClientConfig: FunctionReference<"query", "public", any, any>;
    getCurrentAccount: FunctionReference<"query", "public", any, any>;
  };
  auth: {
    bootstrapCurrentWorkosAccount: FunctionReference<"mutation", "public", any, any>;
  };
  billing: {
    getSummary: FunctionReference<"query", "public", any, any>;
    createSubscriptionCheckout: FunctionReference<"action", "public", any, any>;
    createCustomerPortal: FunctionReference<"action", "public", any, any>;
    retrySeatSync: FunctionReference<"mutation", "public", any, any>;
  };
  credentialsNode: {
    upsertCredential: FunctionReference<"action", "public", any, any>;
  };
  executor: {
    createTask: FunctionReference<"mutation", "public", any, any>;
    resolveApproval: FunctionReference<"mutation", "public", any, any>;
  };
  executorNode: {
    listTools: FunctionReference<"action", "public", any, any>;
    listToolsWithWarnings: FunctionReference<"action", "public", any, any>;
  };
  invites: {
    list: FunctionReference<"query", "public", any, any>;
    create: FunctionReference<"mutation", "public", any, any>;
    revoke: FunctionReference<"mutation", "public", any, any>;
  };
  organizationMembers: {
    list: FunctionReference<"query", "public", any, any>;
    updateRole: FunctionReference<"mutation", "public", any, any>;
    updateBillable: FunctionReference<"mutation", "public", any, any>;
    remove: FunctionReference<"mutation", "public", any, any>;
  };
  organizations: {
    create: FunctionReference<"mutation", "public", any, any>;
    listMine: FunctionReference<"query", "public", any, any>;
    getNavigationState: FunctionReference<"query", "public", any, any>;
    getOrganizationAccess: FunctionReference<"query", "public", any, any>;
    resolveWorkosOrganizationId: FunctionReference<"query", "public", any, any>;
  };
  workspace: {
    bootstrapAnonymousSession: FunctionReference<"mutation", "public", any, any>;
    listRuntimeTargets: FunctionReference<"query", "public", any, any>;
    getTask: FunctionReference<"query", "public", any, any>;
    getTaskInWorkspace: FunctionReference<"query", "public", any, any>;
    listTasks: FunctionReference<"query", "public", any, any>;
    listApprovals: FunctionReference<"query", "public", any, any>;
    listPendingApprovals: FunctionReference<"query", "public", any, any>;
    listTaskEvents: FunctionReference<"query", "public", any, any>;
    upsertAccessPolicy: FunctionReference<"mutation", "public", any, any>;
    listAccessPolicies: FunctionReference<"query", "public", any, any>;
    upsertCredential: FunctionReference<"mutation", "public", any, any>;
    listCredentials: FunctionReference<"query", "public", any, any>;
    listCredentialProviders: FunctionReference<"query", "public", any, any>;
    resolveCredential: FunctionReference<"query", "public", any, any>;
    upsertToolSource: FunctionReference<"mutation", "public", any, any>;
    listToolSources: FunctionReference<"query", "public", any, any>;
    deleteToolSource: FunctionReference<"mutation", "public", any, any>;
  };
  workspaces: {
    create: FunctionReference<"mutation", "public", any, any>;
    list: FunctionReference<"query", "public", any, any>;
    generateWorkspaceIconUploadUrl: FunctionReference<"mutation", "public", any, any>;
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
    authKitEvent: FunctionReference<"mutation", "internal", any, any>;
  };
  billingInternal: {
    getBillingAccessForRequest: FunctionReference<"query", "internal", any, any>;
    getSeatSyncSnapshot: FunctionReference<"query", "internal", any, any>;
    upsertCustomerLink: FunctionReference<"mutation", "internal", any, any>;
    bumpSeatSyncVersion: FunctionReference<"mutation", "internal", any, any>;
    upsertSeatState: FunctionReference<"mutation", "internal", any, any>;
  };
  billingSync: {
    syncSeatQuantity: FunctionReference<"action", "internal", any, any>;
  };
  database: {
    createTask: FunctionReference<"mutation", "internal", any, any>;
    getTask: FunctionReference<"query", "internal", any, any>;
    listTasks: FunctionReference<"query", "internal", any, any>;
    listQueuedTaskIds: FunctionReference<"query", "internal", any, any>;
    listRuntimeTargets: FunctionReference<"query", "internal", any, any>;
    getTaskInWorkspace: FunctionReference<"query", "internal", any, any>;
    markTaskRunning: FunctionReference<"mutation", "internal", any, any>;
    markTaskFinished: FunctionReference<"mutation", "internal", any, any>;
    createApproval: FunctionReference<"mutation", "internal", any, any>;
    getApproval: FunctionReference<"query", "internal", any, any>;
    listApprovals: FunctionReference<"query", "internal", any, any>;
    listPendingApprovals: FunctionReference<"query", "internal", any, any>;
    resolveApproval: FunctionReference<"mutation", "internal", any, any>;
    getApprovalInWorkspace: FunctionReference<"query", "internal", any, any>;
    createAgentTask: FunctionReference<"mutation", "internal", any, any>;
    getAgentTask: FunctionReference<"query", "internal", any, any>;
    updateAgentTask: FunctionReference<"mutation", "internal", any, any>;
    bootstrapAnonymousSession: FunctionReference<"mutation", "internal", any, any>;
    upsertAccessPolicy: FunctionReference<"mutation", "internal", any, any>;
    listAccessPolicies: FunctionReference<"query", "internal", any, any>;
    upsertCredential: FunctionReference<"mutation", "internal", any, any>;
    listCredentials: FunctionReference<"query", "internal", any, any>;
    listCredentialProviders: FunctionReference<"query", "internal", any, any>;
    resolveCredential: FunctionReference<"query", "internal", any, any>;
    upsertToolSource: FunctionReference<"mutation", "internal", any, any>;
    listToolSources: FunctionReference<"query", "internal", any, any>;
    deleteToolSource: FunctionReference<"mutation", "internal", any, any>;
    createTaskEvent: FunctionReference<"mutation", "internal", any, any>;
    listTaskEvents: FunctionReference<"query", "internal", any, any>;
  };
  executor: {
    createTaskInternal: FunctionReference<"mutation", "internal", any, any>;
    resolveApprovalInternal: FunctionReference<"mutation", "internal", any, any>;
    appendRuntimeOutput: FunctionReference<"mutation", "internal", any, any>;
  };
  executorNode: {
    listToolsInternal: FunctionReference<"action", "internal", any, any>;
    listToolsWithWarningsInternal: FunctionReference<"action", "internal", any, any>;
    handleExternalToolCall: FunctionReference<"action", "internal", any, any>;
    runTask: FunctionReference<"action", "internal", any, any>;
  };
  invites: {
    deliverWorkosInvite: FunctionReference<"action", "internal", any, any>;
    revokeWorkosInvite: FunctionReference<"action", "internal", any, any>;
    getInviteDeliveryContext: FunctionReference<"query", "internal", any, any>;
    linkOrganizationToWorkos: FunctionReference<"mutation", "internal", any, any>;
    getInviteById: FunctionReference<"query", "internal", any, any>;
    markInviteDelivered: FunctionReference<"mutation", "internal", any, any>;
    markInviteDeliveryFailed: FunctionReference<"mutation", "internal", any, any>;
  };
  openApiSpecCache: {
    getEntry: FunctionReference<"query", "internal", any, any>;
    putEntry: FunctionReference<"mutation", "internal", any, any>;
    pruneExpired: FunctionReference<"mutation", "internal", any, any>;
  };
  workspaceAuthInternal: {
    getWorkspaceAccessForRequest: FunctionReference<"query", "internal", any, any>;
    getWorkspaceAccessForWorkosSubject: FunctionReference<"query", "internal", any, any>;
  };
  workspaceToolCache: {
    getEntry: FunctionReference<"query", "internal", any, any>;
    putEntry: FunctionReference<"mutation", "internal", any, any>;
    getDtsStorageIds: FunctionReference<"query", "internal", any, any>;
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
};


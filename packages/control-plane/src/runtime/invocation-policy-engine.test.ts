import { describe, expect, it } from "@effect/vitest";

import type { Policy } from "#schema";
import {
  AccountIdSchema,
  OrganizationIdSchema,
  PolicyIdSchema,
  SourceIdSchema,
  WorkspaceIdSchema,
} from "#schema";

import {
  evaluateInvocationPolicy,
  type InvocationDescriptor,
} from "./invocation-policy-engine";

const workspaceId = WorkspaceIdSchema.make("ws_policy_engine");
const organizationId = OrganizationIdSchema.make("org_policy_engine");
const sourceId = SourceIdSchema.make("src_policy_engine");

const now = 1_700_000_000_000;

const baseDescriptor: InvocationDescriptor = {
  toolPath: "vercel.api.dns.createRecord",
  sourceId,
  sourceName: "Vercel",
  sourceKind: "openapi",
  sourceNamespace: "vercel.api.dns",
  operationKind: "write",
  httpMethod: "POST",
  httpPathTemplate: "/v10/domains/{domain}/records",
  graphqlOperationType: null,
};

const basePolicy = (
  patch: Partial<Policy> = {},
): Policy => ({
  id: PolicyIdSchema.make(`pol_${Math.random().toString(36).slice(2, 8)}`),
  scopeType: "workspace",
  organizationId,
  workspaceId,
  targetAccountId: null,
  clientId: null,
  resourceType: "tool_path",
  resourcePattern: "vercel.api.dns.createRecord",
  matchType: "exact",
  effect: "allow",
  approvalMode: "auto",
  argumentConditionsJson: null,
  priority: 0,
  enabled: true,
  createdAt: now,
  updatedAt: now,
  ...patch,
});

describe("invocation-policy-engine", () => {
  it("allows GET requests by default", () => {
    const decision = evaluateInvocationPolicy({
      descriptor: {
        ...baseDescriptor,
        toolPath: "vercel.api.dns.getRecords",
        operationKind: "read",
        httpMethod: "GET",
        httpPathTemplate: "/v4/domains/{domain}/records",
      },
      args: {},
      policies: [],
      context: {
        workspaceId,
        organizationId,
        accountId: null,
        clientId: null,
      },
    });

    expect(decision.kind).toBe("allow");
  });

  it("requires interaction for mutating OpenAPI requests by default", () => {
    const decision = evaluateInvocationPolicy({
      descriptor: baseDescriptor,
      args: { domain: "testing.executor.sh" },
      policies: [],
      context: {
        workspaceId,
        organizationId,
        accountId: null,
        clientId: null,
      },
    });

    expect(decision.kind).toBe("require_interaction");
  });

  it("lets an organization policy allow a mutating request", () => {
    const decision = evaluateInvocationPolicy({
      descriptor: baseDescriptor,
      args: { domain: "testing.executor.sh" },
      policies: [basePolicy({
        id: PolicyIdSchema.make("pol_org_allow"),
        scopeType: "organization",
        workspaceId: null,
      })],
      context: {
        workspaceId,
        organizationId,
        accountId: null,
        clientId: null,
      },
    });

    expect(decision.kind).toBe("allow");
    expect(decision.matchedPolicyId).toBe("pol_org_allow");
  });

  it("prefers a more specific workspace deny over an organization allow", () => {
    const decision = evaluateInvocationPolicy({
      descriptor: baseDescriptor,
      args: { domain: "testing.executor.sh" },
      policies: [
        basePolicy({
          id: PolicyIdSchema.make("pol_org_allow"),
          scopeType: "organization",
          workspaceId: null,
          approvalMode: "auto",
          effect: "allow",
        }),
        basePolicy({
          id: PolicyIdSchema.make("pol_ws_deny"),
          effect: "deny",
          priority: 10,
        }),
      ],
      context: {
        workspaceId,
        organizationId,
        accountId: null,
        clientId: null,
      },
    });

    expect(decision.kind).toBe("deny");
    expect(decision.matchedPolicyId).toBe("pol_ws_deny");
  });

  it("prefers an account-targeted workspace allow over a generic workspace policy", () => {
    const decision = evaluateInvocationPolicy({
      descriptor: baseDescriptor,
      args: { domain: "testing.executor.sh" },
      policies: [
        basePolicy({
          id: PolicyIdSchema.make("pol_ws_gate"),
          approvalMode: "required",
        }),
        basePolicy({
          id: PolicyIdSchema.make("pol_ws_user_allow"),
          targetAccountId: AccountIdSchema.make("acc_user"),
          approvalMode: "auto",
          priority: 1,
        }),
      ],
      context: {
        workspaceId,
        organizationId,
        accountId: AccountIdSchema.make("acc_user"),
        clientId: null,
      },
    });

    expect(decision.kind).toBe("allow");
    expect(decision.matchedPolicyId).toBe("pol_ws_user_allow");
  });
});

import { expect, test } from "bun:test";
import type { ToolPolicyRecord } from "../../../core/src/types";
import { getDecisionForContext } from "./policy";

const basePolicy: Omit<ToolPolicyRecord, "id" | "resourceType" | "resourcePattern"> = {
  scopeType: "organization",
  organizationId: "org_1" as any,
  matchType: "glob",
  effect: "allow",
  approvalMode: "required",
  priority: 100,
  createdAt: 1,
  updatedAt: 1,
};

test("source-scoped policy can deny all tools from a source", () => {
  const policies: ToolPolicyRecord[] = [
    {
      id: "p1",
      ...basePolicy,
      resourceType: "source",
      resourcePattern: "source:github",
      effect: "deny",
      approvalMode: "required",
    },
  ];

  const decision = getDecisionForContext(
    {
      path: "github.repos.list",
      source: "source:github",
      approval: "auto",
    },
    {
      workspaceId: "ws_1",
      accountId: "acct_1",
    },
    policies,
  );

  expect(decision).toBe("deny");
});

test("tool-path policy can override source policy by specificity", () => {
  const policies: ToolPolicyRecord[] = [
    {
      id: "p-source",
      ...basePolicy,
      resourceType: "source",
      resourcePattern: "source:github",
      effect: "allow",
      approvalMode: "auto",
      priority: 80,
    },
    {
      id: "p-tool",
      ...basePolicy,
      resourceType: "tool_path",
      resourcePattern: "github.repos.delete",
      matchType: "exact",
      effect: "deny",
      approvalMode: "required",
      priority: 90,
    },
  ];

  const decision = getDecisionForContext(
    {
      path: "github.repos.delete",
      source: "source:github",
      approval: "auto",
    },
    {
      workspaceId: "ws_1",
      accountId: "acct_1",
    },
    policies,
  );

  expect(decision).toBe("deny");
});

test("all-tools policy applies without source context", () => {
  const policies: ToolPolicyRecord[] = [
    {
      id: "p-all",
      ...basePolicy,
      resourceType: "all_tools",
      resourcePattern: "*",
      effect: "allow",
      approvalMode: "required",
    },
  ];

  const decision = getDecisionForContext(
    {
      path: "catalog.tools",
      approval: "auto",
    },
    {
      workspaceId: "ws_1",
      accountId: "acct_1",
    },
    policies,
  );

  expect(decision).toBe("require_approval");
});

test("discover can be denied by policy", () => {
  const policies: ToolPolicyRecord[] = [
    {
      id: "p-discover-deny",
      ...basePolicy,
      resourceType: "tool_path",
      resourcePattern: "discover",
      matchType: "exact",
      effect: "deny",
      approvalMode: "required",
    },
  ];

  const decision = getDecisionForContext(
    {
      path: "discover",
      approval: "auto",
    },
    {
      workspaceId: "ws_1",
      accountId: "acct_1",
    },
    policies,
  );

  expect(decision).toBe("deny");
});

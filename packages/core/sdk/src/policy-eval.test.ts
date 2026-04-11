import { describe, it } from "@effect/vitest";
import { expect } from "vitest";

import { PolicyId, ScopeId, ToolId } from "./ids";
import { evaluatePolicyDecision } from "./policy-eval";
import { PolicyCheckInput, type Policy } from "./policies";

const scopeId = ScopeId.make("scope-1");
const otherScopeId = ScopeId.make("scope-2");
const toolId = ToolId.make("openapi.stripe.charges.create");

const basePolicy = (patch: Partial<Policy> = {}): Policy => {
  const now = new Date("2026-04-11T00:00:00.000Z");
  return {
    id: PolicyId.make(`policy-${Math.random().toString(36).slice(2, 10)}`),
    scopeId,
    toolPattern: "openapi.stripe.*",
    effect: "allow",
    approvalMode: "auto",
    priority: 0,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
};

const input = new PolicyCheckInput({ scopeId, toolId });

describe("policy-eval", () => {
  it("returns fallback when no policy matches", () => {
    const decision = evaluatePolicyDecision([], input);
    expect(decision.kind).toBe("fallback");
    expect(decision.matchedPolicyId).toBeNull();
  });

  it("ignores disabled and wrong-scope policies", () => {
    const decision = evaluatePolicyDecision(
      [
        basePolicy({ enabled: false }),
        basePolicy({ scopeId: otherScopeId }),
      ],
      input,
    );
    expect(decision.kind).toBe("fallback");
  });

  it("prefers a specific deny over a broad allow", () => {
    const decision = evaluatePolicyDecision(
      [
        basePolicy({
          id: PolicyId.make("policy-allow"),
          toolPattern: "openapi.stripe.*",
          priority: 0,
        }),
        basePolicy({
          id: PolicyId.make("policy-deny"),
          toolPattern: "openapi.stripe.charges.create",
          effect: "deny",
          priority: 0,
        }),
      ],
      input,
    );
    expect(decision.kind).toBe("deny");
    expect(decision.matchedPolicyId).toBe("policy-deny");
  });

  it("returns require_interaction for allow + required", () => {
    const decision = evaluatePolicyDecision(
      [
        basePolicy({
          id: PolicyId.make("policy-required"),
          approvalMode: "required",
        }),
      ],
      input,
    );
    expect(decision.kind).toBe("require_interaction");
    expect(decision.matchedPolicyId).toBe("policy-required");
  });

  it("uses priority plus literal character count for precedence", () => {
    const decision = evaluatePolicyDecision(
      [
        basePolicy({
          id: PolicyId.make("policy-wildcard"),
          toolPattern: "openapi.stripe.*",
          effect: "allow",
          priority: 5,
        }),
        basePolicy({
          id: PolicyId.make("policy-specific"),
          toolPattern: "openapi.stripe.charges.create",
          effect: "deny",
          priority: 0,
        }),
      ],
      input,
    );
    expect(decision.kind).toBe("deny");
    expect(decision.matchedPolicyId).toBe("policy-specific");
  });

  it("breaks specificity ties by newest createdAt", () => {
    const older = new Date("2026-04-11T00:00:00.000Z");
    const newer = new Date("2026-04-11T00:00:01.000Z");

    const decision = evaluatePolicyDecision(
      [
        basePolicy({
          id: PolicyId.make("policy-older"),
          toolPattern: "openapi.stripe.*",
          approvalMode: "auto",
          createdAt: older,
          updatedAt: older,
        }),
        basePolicy({
          id: PolicyId.make("policy-newer"),
          toolPattern: "openapi.stripe.*",
          approvalMode: "required",
          createdAt: newer,
          updatedAt: newer,
        }),
      ],
      input,
    );

    expect(decision.kind).toBe("require_interaction");
    expect(decision.matchedPolicyId).toBe("policy-newer");
  });
});

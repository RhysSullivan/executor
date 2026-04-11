import { PolicyId, ScopeId } from "../../ids";
import { Policy } from "../../policies";
import type { PolicyRow } from "../policy-store";
import type { PolicyAction } from "../../policies";

// ---------------------------------------------------------------------------
// Policy mappers
// ---------------------------------------------------------------------------

export const rowToPolicy = (row: PolicyRow, scopeId: ScopeId): Policy =>
  new Policy({
    id: PolicyId.make(row.id),
    scopeId,
    name: row.name,
    action: row.action as PolicyAction,
    match: {
      toolPattern: row.matchToolPattern ?? undefined,
      sourceId: row.matchSourceId ?? undefined,
    },
    priority: row.priority,
    createdAt: row.createdAt,
  });

export const policyToRow = (policy: Policy): PolicyRow => ({
  id: policy.id as string,
  scopeId: policy.scopeId as string,
  name: policy.name,
  action: policy.action,
  matchToolPattern: policy.match.toolPattern ?? null,
  matchSourceId: policy.match.sourceId ?? null,
  priority: policy.priority,
  createdAt: policy.createdAt,
});

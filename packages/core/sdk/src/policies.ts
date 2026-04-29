// ---------------------------------------------------------------------------
// Tool policies — pattern matcher + policy resolution. Pure functions; the
// executor stitches them into `tools.list`, `tools.invoke`, and the public
// `executor.policies` CRUD surface. Plugins consume the same surface.
// ---------------------------------------------------------------------------

import { Schema } from "effect";

import type { ToolPolicyAction, ToolPolicyRow } from "./core-schema";
import { PolicyId, ScopeId } from "./ids";

// ---------------------------------------------------------------------------
// Public projection — what callers see when they list policies. Strips the
// raw `scope_id` to a readable `scopeId`, hides `created_at` typing
// inconsistencies between adapters, and re-tags `id` as a `PolicyId`.
// ---------------------------------------------------------------------------

export interface ToolPolicy {
  readonly id: PolicyId;
  readonly scopeId: ScopeId;
  readonly pattern: string;
  readonly action: ToolPolicyAction;
  /** Lower number = higher precedence within a scope. */
  readonly position: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateToolPolicyInput {
  readonly scope: string;
  readonly pattern: string;
  readonly action: ToolPolicyAction;
  /** Optional explicit position. Defaults to the top of the scope's list
   *  (smallest position; highest precedence). */
  readonly position?: number;
}

export interface UpdateToolPolicyInput {
  readonly id: string;
  readonly pattern?: string;
  readonly action?: ToolPolicyAction;
  readonly position?: number;
}

// ---------------------------------------------------------------------------
// Match result — what `resolveToolPolicy` returns when a rule fires. Carries
// the matched pattern so error messages and approval prompts can show the
// user *which* rule produced the gate ("matched policy: vercel.dns.*").
// ---------------------------------------------------------------------------

export interface PolicyMatch {
  readonly action: ToolPolicyAction;
  readonly pattern: string;
  readonly policyId: string;
}

// ---------------------------------------------------------------------------
// Pattern matching. v1 grammar:
//   - exact:        `vercel.dns.create`     matches only that id
//   - subtree:      `vercel.dns.*`          matches anything starting with `vercel.dns.`
//   - plugin-wide:  `vercel.*`              matches anything starting with `vercel.`
// `*` is only meaningful as the trailing segment after a dot. Patterns that
// don't end in `.*` are treated as exact-id matches.
// ---------------------------------------------------------------------------

export const matchPattern = (pattern: string, toolId: string): boolean => {
  if (pattern === toolId) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    if (prefix.length === 0) return false;
    return toolId === prefix || toolId.startsWith(`${prefix}.`);
  }
  return false;
};

// ---------------------------------------------------------------------------
// Pattern validation — rejects shapes the matcher can't handle. Used by the
// CRUD path so a malformed rule never lands in the table.
// ---------------------------------------------------------------------------

export const isValidPattern = (pattern: string): boolean => {
  if (pattern.length === 0) return false;
  if (pattern.startsWith(".") || pattern.endsWith(".")) return false;
  if (pattern.includes("..")) return false;
  if (pattern.startsWith("*")) return false;
  // `*` is only valid as the entire trailing segment.
  const segments = pattern.split(".");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.length === 0) return false;
    if (seg.includes("*") && seg !== "*") return false;
    if (seg === "*" && i !== segments.length - 1) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Resolution — given a tool id and the policy rows visible across the
// executor's scope stack, return the first matching rule under the
// (innermost-scope-first, position-ascending) ordering. Caller passes a
// `scopeRank` function so the resolver doesn't need to know the executor's
// scope stack shape.
// ---------------------------------------------------------------------------

export const resolveToolPolicy = (
  toolId: string,
  policies: readonly ToolPolicyRow[],
  scopeRank: (row: { scope_id: unknown }) => number,
): PolicyMatch | undefined => {
  if (policies.length === 0) return undefined;
  const sorted = [...policies].sort((a, b) => {
    const sa = scopeRank(a);
    const sb = scopeRank(b);
    if (sa !== sb) return sa - sb;
    return (a.position as number) - (b.position as number);
  });
  for (const row of sorted) {
    if (matchPattern(row.pattern as string, toolId)) {
      return {
        action: row.action as ToolPolicyAction,
        pattern: row.pattern as string,
        policyId: row.id as string,
      };
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Row → public projection.
// ---------------------------------------------------------------------------

export const rowToToolPolicy = (row: ToolPolicyRow): ToolPolicy => ({
  id: PolicyId.make(row.id as string),
  scopeId: ScopeId.make(row.scope_id as string),
  pattern: row.pattern as string,
  action: row.action as ToolPolicyAction,
  position: row.position as number,
  createdAt: row.created_at as Date,
  updatedAt: row.updated_at as Date,
});

// ---------------------------------------------------------------------------
// Schema for the action enum — useful for HTTP edges that want to validate
// inputs with effect/Schema.
// ---------------------------------------------------------------------------

export const ToolPolicyActionSchema = Schema.Literal(
  "approve",
  "require_approval",
  "block",
);

import { Schema } from "effect";

import { ScopeId } from "./ids";

export class Scope extends Schema.Class<Scope>("Scope")({
  id: ScopeId,
  name: Schema.String,
  createdAt: Schema.DateFromNumber,
}) {}

// ---------------------------------------------------------------------------
// ScopeStack — request-time composition of scopes. `read` is an
// precedence-ordered list (innermost first); on id collision across
// scopes the innermost wins. `write` is the single scope every write
// lands in — must be an element of `read`.
//
// One-element stacks are the common case for single-user hosts (CLI,
// local) and drop back to today's behaviour. Multi-element stacks
// unlock per-user overrides of org-shared rows: cloud hosts build
// `[userScope, orgScope]` per request from the authenticated JWT, and
// scope-aware tables (secret, source, tool, future `policy`) get
// layered resolution for free.
//
// See notes/scopes.md and notes/per-user-scopes.md for the full
// motivation.
// ---------------------------------------------------------------------------

export class ScopeStack extends Schema.Class<ScopeStack>("ScopeStack")({
  read: Schema.Array(Scope),
  write: Scope,
}) {
  static fromScope = (scope: Scope): ScopeStack =>
    new ScopeStack({ read: [scope], write: scope });
}

/** Caller input: a bare Scope (single-scope convenience) or a full
 *  stack. Normalized to `ScopeStack` via {@link normalizeScopeStack}. */
export type ScopeInput = Scope | ScopeStack;

export const normalizeScopeStack = (input: ScopeInput): ScopeStack => {
  if (input instanceof ScopeStack) return input;
  return ScopeStack.fromScope(input);
};

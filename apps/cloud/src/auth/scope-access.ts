// Per-handler scope guard. Cloud's invariant: a URL path param
// `scopeId` is either the caller's `organizationId` or the
// `user-org:${accountId}:${organizationId}` derivative. Every handler
// whose route carries a `scopeId` calls `assertScopeAccess(path.scopeId)`
// before touching the scoped executor — the argument is the decoded
// `ScopeId` from `path`, so the compiler catches typos (no string key
// lookups) and a renamed param on the API side fails the handler's
// types.

import { Effect } from "effect";

import type { ScopeId } from "@executor/sdk";

import { AuthContext, ScopeForbidden } from "./middleware";

const userOrgScopeId = (accountId: string, organizationId: string) =>
  `user-org:${accountId}:${organizationId}`;

export const assertScopeAccess = (
  scopeId: ScopeId,
): Effect.Effect<void, ScopeForbidden, AuthContext> =>
  Effect.gen(function* () {
    const auth = yield* AuthContext;
    if (
      scopeId === auth.organizationId ||
      scopeId === userOrgScopeId(auth.accountId, auth.organizationId)
    ) {
      return;
    }
    return yield* new ScopeForbidden();
  });

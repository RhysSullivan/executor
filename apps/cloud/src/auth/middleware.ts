// ---------------------------------------------------------------------------
// HTTP API middleware tags — pure tag definitions, no server dependencies.
// Live implementations are in ./middleware-live.ts to keep the WorkOS SDK
// out of the client bundle (this file is imported by `auth/api.ts` which
// the SPA pulls in for typed schemas).
// ---------------------------------------------------------------------------

import { Context, Schema } from "effect";
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi";

// ---------------------------------------------------------------------------
// Session — what every authenticated request gets
// ---------------------------------------------------------------------------

export type Session = {
  readonly accountId: string;
  readonly email: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  /** May be null if the user hasn't joined an organization yet. */
  readonly organizationId: string | null;
  readonly sealedSession: string;
  readonly refreshedSession: string | null;
};

export class SessionContext extends Context.Service<SessionContext, Session>()(
  "@executor-js/cloud/Session",
) {}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {}

export class NoOrganization extends Schema.TaggedErrorClass<NoOrganization>()(
  "NoOrganization",
  {},
  { httpApiStatus: 403 },
) {}

// ---------------------------------------------------------------------------
// SessionAuth — resolves the WorkOS session cookie, provides SessionContext
// ---------------------------------------------------------------------------

export class SessionAuth extends HttpApiMiddleware.Service<
  SessionAuth,
  { provides: SessionContext }
>()("SessionAuth", {
  error: Unauthorized,
  security: {
    cookie: HttpApiSecurity.apiKey({ in: "cookie", key: "wos-session" }),
  },
}) {}

// ---------------------------------------------------------------------------
// OrgAuth — like SessionAuth but rejects sessions with no organization
// ---------------------------------------------------------------------------

export class AuthContext extends Context.Service<
  AuthContext,
  {
    readonly accountId: string;
    readonly organizationId: string;
    readonly email: string;
    readonly name: string | null;
    readonly avatarUrl: string | null;
  }
>()("@executor-js/cloud/AuthContext") {}

export class OrgAuth extends HttpApiMiddleware.Service<OrgAuth, { provides: AuthContext }>()(
  "OrgAuth",
  {
    error: [Unauthorized, NoOrganization],
    security: {
      cookie: HttpApiSecurity.apiKey({ in: "cookie", key: "wos-session" }),
    },
  },
) {}

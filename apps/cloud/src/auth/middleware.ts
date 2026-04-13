// ---------------------------------------------------------------------------
// HTTP API middleware tags — pure tag definitions, no server dependencies.
// Live implementations are in ./middleware-live.ts to keep the WorkOS SDK
// out of the client bundle (this file is imported by `auth/api.ts` which
// the SPA pulls in for typed schemas).
// ---------------------------------------------------------------------------

import { Context, Schema } from "effect";
import { HttpApiMiddleware, HttpApiSchema, HttpApiSecurity } from "@effect/platform";

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

export class SessionContext extends Context.Tag("@executor/cloud/Session")<
  SessionContext,
  Session
>() {}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {},
  HttpApiSchema.annotations({ status: 401 }),
) {}

export class NoOrganization extends Schema.TaggedError<NoOrganization>()(
  "NoOrganization",
  {},
  HttpApiSchema.annotations({ status: 403 }),
) {}

// ---------------------------------------------------------------------------
// SessionAuth — resolves the WorkOS session cookie, provides SessionContext
// ---------------------------------------------------------------------------

export class SessionAuth extends HttpApiMiddleware.Tag<SessionAuth>()("SessionAuth", {
  failure: Unauthorized,
  provides: SessionContext,
  security: {
    cookie: HttpApiSecurity.apiKey({ in: "cookie", key: "wos-session" }),
  },
}) {}

// ---------------------------------------------------------------------------
// OrgAuth — like SessionAuth but rejects sessions with no organization
// ---------------------------------------------------------------------------

export class AuthContext extends Context.Tag("@executor/cloud/AuthContext")<
  AuthContext,
  {
    readonly accountId: string;
    readonly organizationId: string;
    readonly email: string;
    readonly name: string | null;
    readonly avatarUrl: string | null;
  }
>() {}

export class OrgAuth extends HttpApiMiddleware.Tag<OrgAuth>()("OrgAuth", {
  failure: Schema.Union(Unauthorized, NoOrganization),
  provides: AuthContext,
  security: {
    cookie: HttpApiSecurity.apiKey({ in: "cookie", key: "wos-session" }),
  },
}) {}

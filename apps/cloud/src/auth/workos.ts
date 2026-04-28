// ---------------------------------------------------------------------------
// WorkOS AuthKit — Effect-native sealed session management
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Context, Effect, Layer } from "effect";
import { WorkOS } from "@workos-inc/node/worker";
import { WorkOSError, tryPromiseService, withServiceLogging } from "./errors";

const COOKIE_NAME = "wos-session";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const apiKey = env.WORKOS_API_KEY;
  const clientId = env.WORKOS_CLIENT_ID;
  const cookiePassword = env.WORKOS_COOKIE_PASSWORD;

  if (!cookiePassword || cookiePassword.length < 32) {
    return yield* Effect.die(new Error("WORKOS_COOKIE_PASSWORD must be at least 32 characters"));
  }

  const workos = new WorkOS({ apiKey, clientId });

  const use = <A>(fn: (wos: WorkOS) => Promise<A>) =>
    withServiceLogging(
      "workos",
      () => new WorkOSError(),
      tryPromiseService(() => fn(workos)),
    );

  const authenticateSealedSession = (sessionData: string) =>
    Effect.gen(function* () {
      if (!sessionData) return null;

      const session = workos.userManagement.loadSealedSession({
        sessionData,
        cookiePassword,
      });

      const result = yield* use(() => session.authenticate());

      if (result.authenticated) {
        return {
          userId: result.user.id,
          email: result.user.email,
          firstName: result.user.firstName,
          lastName: result.user.lastName,
          avatarUrl: result.user.profilePictureUrl,
          organizationId: result.organizationId,
          sessionId: result.sessionId,
          refreshedSession: undefined as string | undefined,
        };
      }

      if (result.reason === "no_session_cookie_provided") return null;

      // Try refreshing
      const refreshed = yield* use(() => session.refresh()).pipe(
        Effect.orElseSucceed(() => ({ authenticated: false as const })),
      );

      if (!refreshed.authenticated || !("sealedSession" in refreshed) || !refreshed.sealedSession)
        return null;

      return {
        userId: refreshed.user.id,
        email: refreshed.user.email,
        firstName: refreshed.user.firstName,
        lastName: refreshed.user.lastName,
        avatarUrl: refreshed.user.profilePictureUrl,
        organizationId: refreshed.organizationId,
        sessionId: refreshed.sessionId,
        refreshedSession: refreshed.sealedSession,
      };
    });

  return {
    getAuthorizationUrl: (redirectUri: string, state?: string) =>
      workos.userManagement.getAuthorizationUrl({
        provider: "authkit",
        redirectUri,
        clientId,
        ...(state ? { state } : {}),
      }),

    authenticateWithCode: (code: string) =>
      use((wos) =>
        wos.userManagement.authenticateWithCode({
          code,
          clientId,
          session: { sealSession: true, cookiePassword },
        }),
      ),

    /** Create a new organization in WorkOS. */
    createOrganization: (name: string) =>
      use((wos) => wos.organizations.createOrganization({ name })),

    /** Add a user to an organization. */
    createMembership: (organizationId: string, userId: string, roleSlug?: string) =>
      use((wos) =>
        wos.userManagement.createOrganizationMembership({
          organizationId,
          userId,
          ...(roleSlug ? { roleSlug } : {}),
        }),
      ),

    /** List organization memberships for a user. */
    listUserMemberships: (userId: string) =>
      use((wos) =>
        wos.userManagement.listOrganizationMemberships({
          userId,
          statuses: ["active", "pending"],
        }),
      ),

    /**
     * Refresh a sealed session, optionally switching to a new organization.
     * Returns the new sealed session string or null if refresh failed.
     */
    refreshSession: (sessionData: string, organizationId?: string) =>
      Effect.gen(function* () {
        const session = workos.userManagement.loadSealedSession({
          sessionData,
          cookiePassword,
        });
        const refreshed = yield* use(() =>
          session.refresh(organizationId ? { organizationId } : undefined),
        );
        if (!refreshed.authenticated || !("sealedSession" in refreshed)) return null;
        return refreshed.sealedSession ?? null;
      }),

    /**
     * Authenticate a sealed session string. Returns the user info plus
     * any refreshed session that needs to be set on the response.
     * Returns null if the session is missing or invalid.
     */
    authenticateSealedSession,

    /** Authenticate from a Request — convenience wrapper around `authenticateSealedSession`. */
    authenticateRequest: (request: Request) =>
      Effect.gen(function* () {
        const sessionData = parseCookie(request.headers.get("cookie"), COOKIE_NAME);
        if (!sessionData) return null;
        return yield* authenticateSealedSession(sessionData);
      }),

    /** List organization memberships with user details. */
    listOrgMembers: (organizationId: string) =>
      use((wos) =>
        wos.userManagement.listOrganizationMemberships({
          organizationId,
          statuses: ["active", "pending"],
        }),
      ),

    /** Get a user by ID. */
    getUser: (userId: string) => use((wos) => wos.userManagement.getUser(userId)),

    /** Send an organization invitation. */
    sendInvitation: (params: { email: string; organizationId: string; roleSlug?: string }) =>
      use((wos) =>
        wos.userManagement.sendInvitation({
          email: params.email,
          organizationId: params.organizationId,
          roleSlug: params.roleSlug,
        }),
      ),

    /** Remove an organization membership. */
    deleteOrgMembership: (membershipId: string) =>
      use((wos) => wos.userManagement.deleteOrganizationMembership(membershipId)),

    /** Get the role for a membership. */
    getOrgMembership: (membershipId: string) =>
      use((wos) => wos.userManagement.getOrganizationMembership(membershipId)),

    /** Update a membership's role. */
    updateOrgMembershipRole: (membershipId: string, roleSlug: string) =>
      use((wos) => wos.userManagement.updateOrganizationMembership(membershipId, { roleSlug })),

    /** List available roles for an organization. */
    listOrgRoles: (organizationId: string) =>
      use((wos) => wos.organizations.listOrganizationRoles({ organizationId })),

    /** Get an organization (includes domains). */
    getOrganization: (organizationId: string) =>
      use((wos) => wos.organizations.getOrganization(organizationId)),

    /** Update an organization. */
    updateOrganization: (organizationId: string, name: string) =>
      use((wos) => wos.organizations.updateOrganization({ organization: organizationId, name })),

    /** Generate an Admin Portal link for domain verification. */
    generateDomainVerificationPortalLink: (organizationId: string, returnUrl: string) =>
      use((wos) =>
        wos.portal.generateLink({
          organization: organizationId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          intent: "domain_verification" as any,
          returnUrl,
        }),
      ),

    /** Get a domain by ID. */
    getOrganizationDomain: (domainId: string) =>
      use((wos) => wos.organizationDomains.get(domainId)),

    /** Delete a domain claim. */
    deleteOrganizationDomain: (domainId: string) =>
      use((wos) => wos.organizationDomains.delete(domainId)),
  };
});

export type WorkOSAuthService = Effect.Effect.Success<typeof make>;

export class WorkOSAuth extends Context.Tag("@executor/cloud/WorkOSAuth")<
  WorkOSAuth,
  WorkOSAuthService
>() {
  static Default = Layer.effect(this, make).pipe(Layer.annotateSpans({ module: "WorkOSAuth" }));
}

const parseCookie = (cookieHeader: string | null, name: string): string | null => {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  return match.slice(name.length + 1) || null;
};

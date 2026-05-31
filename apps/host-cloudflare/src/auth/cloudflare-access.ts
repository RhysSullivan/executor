import { createRemoteJWKSet, jwtVerify } from "jose";
import { Effect, Layer } from "effect";

import { IdentityProvider, Unauthorized, type Principal } from "@executor-js/api/server";

import type { CloudflareConfig } from "../config";

// ---------------------------------------------------------------------------
// Cloudflare Access IdentityProvider — the CF-native swap for self-host's
// Better Auth. Cloudflare Access (Zero Trust) sits IN FRONT of the Worker and
// authenticates the human; it forwards a signed `Cf-Access-Jwt-Assertion` JWT.
// This provider verifies that JWT against the team's public JWKS and maps its
// claims onto the neutral `Principal`. There is no app-level login, no session
// store, no password — the IdP is the gate.
//
// Single-tenant: every verified principal belongs to the one configured org.
// Roles come from the admin allowlist + the Access groups claim.
// ---------------------------------------------------------------------------

/**
 * Resolve a request to its verified `Principal`, or `null` when the Access
 * assertion is missing/invalid. The single source of truth for "who is this
 * request", shared by the `IdentityProvider` (the API gate) and the MCP auth
 * provider (the `/mcp` gate) so both enforce Access identically.
 *
 * `jose` caches + rotates the team JWKS, so build the verifier once per config.
 */
export const makeAccessVerifier = (config: CloudflareConfig) => {
  const issuer = `https://${config.accessTeamDomain}`;
  // Cached, lazily-fetched team signing keys; jose handles rotation + caching.
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  // Dev/single-user escape hatch: bypass Access entirely, every request is a
  // fixed admin. Only when explicitly enabled (and the instance is otherwise
  // unprotected). Mirrors the local app's single-user model.
  const devPrincipal: Principal = {
    accountId: "dev",
    organizationId: config.organizationId,
    organizationName: config.organizationName,
    email: config.adminEmails[0] ?? "dev@local",
    name: "Dev",
    avatarUrl: null,
    roles: ["admin"],
  };

  const verify = (request: Request): Effect.Effect<Principal | null> =>
    Effect.gen(function* () {
      if (config.enableDevAuth) return devPrincipal;
      const token = request.headers.get("Cf-Access-Jwt-Assertion");
      if (!token) return null;

      const verified = yield* Effect.tryPromise({
        try: () => jwtVerify(token, jwks, { issuer, audience: config.accessAud }),
        catch: () => "invalid access assertion",
      }).pipe(Effect.orElseSucceed(() => null));
      if (!verified) return null;

      const claims = verified.payload as Record<string, unknown>;
      const email = typeof claims.email === "string" ? claims.email : "";
      const nameClaim = claims[config.accessNameClaim];
      const groupsClaim = claims[config.accessGroupsClaim];
      const groups = Array.isArray(groupsClaim) ? groupsClaim.map(String) : [];
      const isAdmin = email.length > 0 && config.adminEmails.includes(email.toLowerCase());

      return {
        accountId: typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : email,
        organizationId: config.organizationId,
        organizationName: config.organizationName,
        email,
        name: typeof nameClaim === "string" ? nameClaim : null,
        avatarUrl: null,
        roles: isAdmin ? ["admin", ...groups] : groups.length > 0 ? groups : ["member"],
      } satisfies Principal;
    });

  return { verify };
};

export const cloudflareAccessIdentityLayer = (
  config: CloudflareConfig,
): Layer.Layer<IdentityProvider> => {
  const { verify } = makeAccessVerifier(config);
  return Layer.succeed(IdentityProvider)(
    IdentityProvider.of({
      authenticate: (request) =>
        verify(request).pipe(
          Effect.flatMap((principal) =>
            principal ? Effect.succeed(principal) : Effect.fail(new Unauthorized()),
          ),
        ),
    }),
  );
};

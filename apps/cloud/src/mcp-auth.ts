import { Data, Effect } from "effect";
import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { JWTExpired } from "jose/errors";

export type VerifiedToken = {
  /** The WorkOS account ID (user ID). */
  accountId: string;
  /** The WorkOS organization ID, if the session has org context. */
  organizationId: string | null;
};

export class McpJwtVerificationError extends Data.TaggedError("McpJwtVerificationError")<{
  readonly cause: unknown;
  readonly reason: "expired" | "invalid";
}> {}

export const verifyMcpAccessToken = Effect.fn("mcp.auth.jwt_verify")(function* (
  token: string,
  jwks: JWTVerifyGetKey,
  options: {
    readonly issuer: string;
    readonly audience?: string;
  },
) {
  const { payload } = yield* Effect.tryPromise({
    try: () =>
      jwtVerify(token, jwks, {
        issuer: options.issuer,
        ...(options.audience ? { audience: options.audience } : {}),
      }),
    catch: (cause) =>
      new McpJwtVerificationError({
        cause,
        reason: cause instanceof JWTExpired ? "expired" : "invalid",
      }),
  });

  if (!payload.sub) return null;

  return {
    accountId: payload.sub,
    organizationId: (payload.org_id as string | undefined) ?? null,
  } satisfies VerifiedToken;
});

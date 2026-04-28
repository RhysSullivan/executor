import { Data, Effect, Either } from "effect";
import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { JOSEError, JWKSInvalid, JWKSTimeout, JWTExpired } from "jose/errors";

export type VerifiedToken = {
  /** The WorkOS account ID (user ID). */
  accountId: string;
  /** The WorkOS organization ID, if the session has org context. */
  organizationId: string | null;
};

export class McpJwtVerificationError extends Data.TaggedError("McpJwtVerificationError")<{
  readonly cause: unknown;
  readonly reason: "expired" | "invalid" | "system";
}> {}

const classifyJwtVerificationError = (cause: unknown): McpJwtVerificationError =>
  new McpJwtVerificationError({
    cause,
    reason:
      cause instanceof JWTExpired
        ? "expired"
        : cause instanceof JWKSTimeout ||
            cause instanceof JWKSInvalid ||
            !(cause instanceof JOSEError)
          ? "system"
          : "invalid",
  });

const isExpectedJwtVerificationError = (error: McpJwtVerificationError): boolean =>
  error.reason === "expired" || error.reason === "invalid";

const withJwtVerificationSpan = <A>(
  effect: Effect.Effect<A, McpJwtVerificationError>,
): Effect.Effect<A, McpJwtVerificationError> =>
  effect.pipe(
    Effect.either,
    Effect.flatMap((outcome) =>
      Effect.gen(function* () {
        if (Either.isRight(outcome)) {
          yield* Effect.annotateCurrentSpan({ "mcp.auth.jwt_verify.outcome": "verified" });
          return outcome;
        }

        yield* Effect.annotateCurrentSpan({
          "mcp.auth.jwt_verify.outcome": outcome.left.reason,
        });

        return isExpectedJwtVerificationError(outcome.left)
          ? outcome
          : yield* Effect.fail(outcome.left);
      }),
    ),
    Effect.withSpan("mcp.auth.jwt_verify"),
    Effect.flatMap((outcome) =>
      Either.isRight(outcome) ? Effect.succeed(outcome.right) : Effect.fail(outcome.left),
    ),
  );

export const verifyMcpAccessToken = (
  token: string,
  jwks: JWTVerifyGetKey,
  options: {
    readonly issuer: string;
    readonly audience: string;
  },
) =>
  Effect.gen(function* () {
    const { payload } = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(token, jwks, {
          issuer: options.issuer,
          audience: options.audience,
        }),
      catch: classifyJwtVerificationError,
    }).pipe(withJwtVerificationSpan);

    if (!payload.sub) return null;

    return {
      accountId: payload.sub,
      organizationId: (payload.org_id as string | undefined) ?? null,
    } satisfies VerifiedToken;
  });

export const verifyWorkOSMcpAccessToken = (
  token: string,
  jwks: JWTVerifyGetKey,
  options: {
    readonly issuer: string;
    readonly audience: string;
  },
) =>
  Effect.gen(function* () {
    const verified = yield* verifyMcpAccessToken(token, jwks, {
      issuer: options.issuer,
      audience: options.audience,
    });
    yield* Effect.annotateCurrentSpan({
      "mcp.auth.audience_mode": "workos_client",
    });
    return verified;
  });

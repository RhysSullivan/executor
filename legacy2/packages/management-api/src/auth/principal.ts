import * as PlatformHeaders from "@effect/platform/Headers";
import { ActorUnauthenticatedError } from "@executor-v2/domain";
import {
  PrincipalProviderSchema,
  PrincipalSchema,
  type Principal,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

export const ControlPlaneAuthHeaders = {
  accountId: "x-executor-account-id",
  principalProvider: "x-executor-principal-provider",
  principalSubject: "x-executor-principal-subject",
  principalEmail: "x-executor-principal-email",
  principalDisplayName: "x-executor-principal-name",
} as const;

const decodePrincipal = Schema.decodeUnknown(PrincipalSchema);
const decodePrincipalProvider = Schema.decodeUnknown(PrincipalProviderSchema);

const headerValue = (
  headers: PlatformHeaders.Headers,
  name: string,
): string | null => {
  const value = Option.getOrNull(PlatformHeaders.get(headers, name));
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toUnauthenticatedError = (
  message: string,
  cause?: unknown,
): ActorUnauthenticatedError =>
  new ActorUnauthenticatedError({
    message:
      cause === undefined
        ? message
        : `${message}: ${
            ParseResult.isParseError(cause)
              ? ParseResult.TreeFormatter.formatErrorSync(cause)
              : String(cause)
          }`,
  });

export const readPrincipalFromHeaders = (
  headers: PlatformHeaders.Headers,
): Effect.Effect<Principal | null, ActorUnauthenticatedError> =>
  Effect.gen(function* () {
    const accountId = headerValue(headers, ControlPlaneAuthHeaders.accountId);

    if (accountId === null) {
      return null;
    }

    const providerRaw =
      headerValue(headers, ControlPlaneAuthHeaders.principalProvider) ?? "local";
    const provider = yield* decodePrincipalProvider(providerRaw).pipe(
      Effect.mapError((cause) =>
        toUnauthenticatedError("Invalid principal provider header", cause),
      ),
    );

    const subject =
      headerValue(headers, ControlPlaneAuthHeaders.principalSubject) ??
      `${provider}:${accountId}`;

    return yield* decodePrincipal({
      accountId,
      provider,
      subject,
      email: headerValue(headers, ControlPlaneAuthHeaders.principalEmail),
      displayName: headerValue(
        headers,
        ControlPlaneAuthHeaders.principalDisplayName,
      ),
    }).pipe(
      Effect.mapError((cause) =>
        toUnauthenticatedError("Invalid principal headers", cause),
      ),
    );
  });

export const requirePrincipalFromHeaders = (
  headers: PlatformHeaders.Headers,
): Effect.Effect<Principal, ActorUnauthenticatedError> =>
  Effect.flatMap(readPrincipalFromHeaders(headers), (principal) =>
    principal === null
      ? Effect.fail(
          new ActorUnauthenticatedError({
            message: `Missing required header: ${ControlPlaneAuthHeaders.accountId}`,
          }),
        )
      : Effect.succeed(principal),
  );

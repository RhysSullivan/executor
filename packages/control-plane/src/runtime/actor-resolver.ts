import * as PlatformHeaders from "@effect/platform/Headers";
import {
  type ControlPlaneActorResolverShape,
  deriveWorkspaceMembershipsForPrincipal,
} from "#api";
import {
  ActorUnauthenticatedError,
  makeActor,
} from "#domain";
import { type SqlControlPlaneRows } from "#persistence";
import {
  PrincipalProviderSchema,
  PrincipalSchema,
  type Principal,
} from "#schema";
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

const readPrincipalFromHeaders = (
  headers: PlatformHeaders.Headers,
): Effect.Effect<Principal, ActorUnauthenticatedError> =>
  Effect.gen(function* () {
    const accountId = headerValue(headers, ControlPlaneAuthHeaders.accountId);
    if (accountId === null) {
      return yield* Effect.fail(
        new ActorUnauthenticatedError({
          message: `Missing required header: ${ControlPlaneAuthHeaders.accountId}`,
        }),
      );
    }

    const providerRaw =
      headerValue(headers, ControlPlaneAuthHeaders.principalProvider) ?? "local";
    const provider = yield* decodePrincipalProvider(providerRaw).pipe(
      Effect.mapError((cause) =>
        toUnauthenticatedError("Invalid principal provider header", cause),
      ),
    );

    const subject =
      headerValue(headers, ControlPlaneAuthHeaders.principalSubject)
      ?? `${provider}:${accountId}`;

    return yield* decodePrincipal({
      accountId,
      provider,
      subject,
      email: headerValue(headers, ControlPlaneAuthHeaders.principalEmail),
      displayName: headerValue(headers, ControlPlaneAuthHeaders.principalDisplayName),
    }).pipe(
      Effect.mapError((cause) =>
        toUnauthenticatedError("Invalid principal headers", cause),
      ),
    );
  });

export const makeHeaderActorResolver = (
  rows: SqlControlPlaneRows,
): ControlPlaneActorResolverShape => ({
  resolveActor: ({ headers }) =>
    Effect.gen(function* () {
      const principal = yield* readPrincipalFromHeaders(headers);
      const organizationMemberships = yield* rows.organizationMemberships
        .listByAccountId(principal.accountId)
        .pipe(
          Effect.mapError((cause) =>
            toUnauthenticatedError("Failed loading memberships", cause),
          ),
        );

      return yield* makeActor({
        principal,
        workspaceMemberships: [],
        organizationMemberships,
      });
    }),

  resolveWorkspaceActor: ({ workspaceId, headers }) =>
    Effect.gen(function* () {
      const principal = yield* readPrincipalFromHeaders(headers);
      const organizationMemberships = yield* rows.organizationMemberships
        .listByAccountId(principal.accountId)
        .pipe(
          Effect.mapError((cause) =>
            toUnauthenticatedError("Failed loading memberships", cause),
          ),
        );

      const workspaceOption = yield* rows.workspaces.getById(workspaceId).pipe(
        Effect.mapError((cause) =>
          toUnauthenticatedError("Failed loading workspace context", cause),
        ),
      );
      const workspace = Option.getOrNull(workspaceOption);

      const workspaceMemberships = deriveWorkspaceMembershipsForPrincipal({
        principalAccountId: principal.accountId,
        workspaceId,
        workspace,
        organizationMemberships,
      });

      return yield* makeActor({
        principal,
        workspaceMemberships,
        organizationMemberships,
      });
    }),
});

import type { RuntimeToolCallRequest } from "@executor-v2/sdk";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class CredentialResolverError extends Data.TaggedError(
  "CredentialResolverError",
)<{
  operation: string;
  message: string;
  details: string | null;
}> {}

export type ResolvedToolCredentials = {
  headers: Readonly<Record<string, string>>;
};

export type CredentialResolverShape = {
  resolveForToolCall: (
    input: RuntimeToolCallRequest,
  ) => Effect.Effect<ResolvedToolCredentials, CredentialResolverError>;
};

export class CredentialResolver extends Context.Tag(
  "@executor-v2/domain/CredentialResolver",
)<CredentialResolver, CredentialResolverShape>() {}

export const makeCredentialResolver = (
  resolveForToolCall: CredentialResolverShape["resolveForToolCall"],
): CredentialResolverShape => ({
  resolveForToolCall,
});

const emptyResolvedToolCredentials: ResolvedToolCredentials = {
  headers: {},
};

export const CredentialResolverNoneLive = Layer.succeed(
  CredentialResolver,
  CredentialResolver.of(
    makeCredentialResolver(() => Effect.succeed(emptyResolvedToolCredentials)),
  ),
);

import {
  CredentialResolver,
  makeCredentialResolver,
} from "@executor-v2/domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const PmCredentialResolverLive = Layer.succeed(
  CredentialResolver,
  CredentialResolver.of(
    makeCredentialResolver(() =>
      Effect.succeed({
        headers: {},
      }),
    ),
  ),
);

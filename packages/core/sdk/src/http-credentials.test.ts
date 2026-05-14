import { describe, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";

import { CredentialBindingRef } from "./credential-bindings";
import { prepareHttpCredentialMap, resolveConfiguredHttpCredentialMap } from "./http-credentials";
import { ConnectionId, CredentialBindingId, ScopeId, SecretId } from "./ids";

class TestCredentialError extends Data.TaggedError("TestCredentialError")<{
  readonly message: string;
}> {}

describe("http credential helpers", () => {
  it.effect("prepares direct secret inputs into configured credential bindings", () =>
    Effect.sync(() => {
      const prepared = prepareHttpCredentialMap({
        values: {
          Authorization: {
            secretId: "api-token",
            prefix: "Bearer ",
            targetScope: ScopeId.make("user"),
            secretScopeId: ScopeId.make("org"),
          },
          "X-Static": "static",
          "X-Slot": { kind: "binding", slot: "header:x-slot" },
        },
        slotForName: (name) => `header:${name.toLowerCase()}`,
      });

      expect(prepared.values).toEqual({
        Authorization: {
          kind: "binding",
          slot: "header:authorization",
          prefix: "Bearer ",
        },
        "X-Static": "static",
        "X-Slot": { kind: "binding", slot: "header:x-slot" },
      });
      expect(prepared.bindings).toEqual([
        {
          slotKey: "header:authorization",
          targetScope: ScopeId.make("user"),
          value: {
            kind: "secret",
            secretId: SecretId.make("api-token"),
            secretScopeId: ScopeId.make("org"),
          },
        },
      ]);
    }),
  );

  it.effect("resolves configured text and secret bindings", () =>
    Effect.gen(function* () {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const bindings = [
        CredentialBindingRef.make({
          id: CredentialBindingId.make("secret-binding"),
          pluginId: "test",
          sourceId: "source",
          sourceScopeId: ScopeId.make("org"),
          scopeId: ScopeId.make("user"),
          slotKey: "header:authorization",
          value: { kind: "secret", secretId: SecretId.make("api-token") },
          createdAt: now,
          updatedAt: now,
        }),
        CredentialBindingRef.make({
          id: CredentialBindingId.make("text-binding"),
          pluginId: "test",
          sourceId: "source",
          sourceScopeId: ScopeId.make("org"),
          scopeId: ScopeId.make("user"),
          slotKey: "query_param:mode",
          value: { kind: "text", text: "fast" },
          createdAt: now,
          updatedAt: now,
        }),
      ];

      const resolved = yield* resolveConfiguredHttpCredentialMap({
        credentialBindings: {
          listForSource: () => Effect.succeed(bindings),
        },
        pluginId: "test",
        sourceId: "source",
        sourceScope: ScopeId.make("org"),
        values: {
          Authorization: {
            kind: "binding",
            slot: "header:authorization",
            prefix: "Bearer ",
          },
          mode: { kind: "binding", slot: "query_param:mode" },
        },
        getSecretAtScope: (secretId, scopeId) =>
          Effect.succeed(
            secretId === SecretId.make("api-token") && scopeId === ScopeId.make("user")
              ? "token"
              : null,
          ),
        onMissingBinding: (name) => new TestCredentialError({ message: `missing binding ${name}` }),
        onMissingSecret: (name) => new TestCredentialError({ message: `missing secret ${name}` }),
      });

      expect(resolved).toEqual({
        Authorization: "Bearer token",
        mode: "fast",
      });
    }),
  );

  it.effect("treats connection bindings as missing for HTTP credential values", () =>
    Effect.gen(function* () {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const failure = yield* resolveConfiguredHttpCredentialMap({
        credentialBindings: {
          listForSource: () =>
            Effect.succeed([
              CredentialBindingRef.make({
                id: CredentialBindingId.make("connection-binding"),
                pluginId: "test",
                sourceId: "source",
                sourceScopeId: ScopeId.make("org"),
                scopeId: ScopeId.make("user"),
                slotKey: "header:authorization",
                value: {
                  kind: "connection",
                  connectionId: ConnectionId.make("conn"),
                },
                createdAt: now,
                updatedAt: now,
              }),
            ]),
        },
        pluginId: "test",
        sourceId: "source",
        sourceScope: ScopeId.make("org"),
        values: {
          Authorization: { kind: "binding", slot: "header:authorization" },
        },
        getSecretAtScope: () => Effect.succeed(null),
        onMissingBinding: (name) => new TestCredentialError({ message: `missing binding ${name}` }),
        onMissingSecret: (name) => new TestCredentialError({ message: `missing secret ${name}` }),
      }).pipe(Effect.flip);

      expect(failure.message).toBe("missing binding Authorization");
    }),
  );
});

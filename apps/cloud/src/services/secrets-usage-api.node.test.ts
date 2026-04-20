import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ScopeId, SecretId } from "@executor/sdk";

import { asOrg } from "./__test-harness__/api-harness";

describe("secrets usage api (HTTP)", () => {
  it.effect("lists source usage for secrets referenced by source config", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const secretId = `sec_${crypto.randomUUID().slice(0, 8)}`;
      const namespace = `api_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(org, (client) =>
        client.secrets.set({
          path: { scopeId: ScopeId.make(org) },
          payload: { id: SecretId.make(secretId), name: "Shared token", value: "sk-test-usage" },
        }),
      );

      yield* asOrg(org, (client) =>
        client.openapi.addSpec({
          path: { scopeId: ScopeId.make(org) },
          payload: {
            spec: "https://openapi.vercel.sh",
            namespace,
            baseUrl: "https://api.vercel.com",
            headers: {
              Authorization: {
                secretId,
                prefix: "Bearer ",
              },
            },
          },
        }),
      );

      const usage = yield* asOrg(org, (client) =>
        client.secretsUsage.list({ path: { scopeId: ScopeId.make(org) } }),
      );

      expect(usage).toEqual([
        {
          secretId,
          usedBy: [
            {
              sourceId: namespace,
              sourceName: "Vercel API",
              sourceKind: "openapi",
            },
          ],
        },
      ]);
    }),
  );

  it.effect("does not leak usage across orgs", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const secretId = `sec_${crypto.randomUUID().slice(0, 8)}`;
      const namespace = `api_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(orgA, (client) =>
        client.secrets.set({
          path: { scopeId: ScopeId.make(orgA) },
          payload: { id: SecretId.make(secretId), name: "Shared token", value: "sk-test-usage" },
        }),
      );

      yield* asOrg(orgA, (client) =>
        client.openapi.addSpec({
          path: { scopeId: ScopeId.make(orgA) },
          payload: {
            spec: "https://openapi.vercel.sh",
            namespace,
            baseUrl: "https://api.vercel.com",
            headers: {
              Authorization: {
                secretId,
                prefix: "Bearer ",
              },
            },
          },
        }),
      );

      const usage = yield* asOrg(orgB, (client) =>
        client.secretsUsage.list({ path: { scopeId: ScopeId.make(orgB) } }),
      );

      expect(usage).toEqual([]);
    }),
  );
});

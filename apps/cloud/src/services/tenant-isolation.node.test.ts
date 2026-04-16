// Tenant isolation integration test. Runs in plain node (not workerd)
// via vitest.node.config.ts — workerd's dev-mode compile stack crashes
// on the full cloud module graph.

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ScopeId, SecretId } from "@executor/sdk";

import { asOrg } from "./__test-harness__/api-harness";

const MINIMAL_OPENAPI_SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Tenant Test API", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

describe("tenant isolation (HTTP)", () => {
  it.effect("sources.list does not leak across orgs", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const namespaceA = `a_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(orgA, (client) =>
        client.openapi.addSpec({
          path: { scopeId: ScopeId.make(orgA) },
          payload: { spec: MINIMAL_OPENAPI_SPEC, namespace: namespaceA },
        }),
      );

      const orgBSources = yield* asOrg(orgB, (client) =>
        client.sources.list({ path: { scopeId: ScopeId.make(orgB) } }),
      );
      expect(orgBSources.map((s) => s.id)).not.toContain(namespaceA);
    }),
  );

  it.effect("tools.list does not leak across orgs", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const namespaceA = `a_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(orgA, (client) =>
        client.openapi.addSpec({
          path: { scopeId: ScopeId.make(orgA) },
          payload: { spec: MINIMAL_OPENAPI_SPEC, namespace: namespaceA },
        }),
      );

      const orgBTools = yield* asOrg(orgB, (client) =>
        client.tools.list({ path: { scopeId: ScopeId.make(orgB) } }),
      );
      expect(orgBTools.map((t) => t.sourceId)).not.toContain(namespaceA);
    }),
  );

  it.effect("openapi.getSource cannot reach another org's source by namespace", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const namespaceA = `a_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(orgA, (client) =>
        client.openapi.addSpec({
          path: { scopeId: ScopeId.make(orgA) },
          payload: { spec: MINIMAL_OPENAPI_SPEC, namespace: namespaceA },
        }),
      );

      const result = yield* asOrg(orgB, (client) =>
        client.openapi
          .getSource({ path: { scopeId: ScopeId.make(orgB), namespace: namespaceA } })
          .pipe(Effect.either),
      );

      if (result._tag === "Right") {
        expect(result.right).toBeNull();
      }
    }),
  );

  it.effect("secrets.list does not leak across orgs", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const secretIdA = `sec_a_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(orgA, (client) =>
        client.secrets.set({
          path: { scopeId: ScopeId.make(orgA) },
          payload: { id: SecretId.make(secretIdA), name: "org-a only", value: "super-secret-a" },
        }),
      );

      const orgBSecrets = yield* asOrg(orgB, (client) =>
        client.secrets.list({ path: { scopeId: ScopeId.make(orgB) } }),
      );
      expect(orgBSecrets.map((s) => s.id)).not.toContain(secretIdA);
    }),
  );

  it.effect("secrets.status reports another org's secret as missing", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const secretIdA = `sec_a_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(orgA, (client) =>
        client.secrets.set({
          path: { scopeId: ScopeId.make(orgA) },
          payload: { id: SecretId.make(secretIdA), name: "org-a only", value: "super-secret-a" },
        }),
      );

      const result = yield* asOrg(orgB, (client) =>
        client.secrets
          .status({ path: { scopeId: ScopeId.make(orgB), secretId: SecretId.make(secretIdA) } })
          .pipe(Effect.either),
      );

      if (result._tag === "Right") {
        expect(result.right.status).toBe("missing");
      }
    }),
  );

  it.effect("secrets.resolve cannot return another org's plaintext", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const secretIdA = `sec_a_${crypto.randomUUID().slice(0, 8)}`;

      yield* asOrg(orgA, (client) =>
        client.secrets.set({
          path: { scopeId: ScopeId.make(orgA) },
          payload: { id: SecretId.make(secretIdA), name: "org-a only", value: "super-secret-a" },
        }),
      );

      const result = yield* asOrg(orgB, (client) =>
        client.secrets
          .resolve({ path: { scopeId: ScopeId.make(orgB), secretId: SecretId.make(secretIdA) } })
          .pipe(Effect.either),
      );

      expect(result._tag).toBe("Left");
    }),
  );
});

// Source endpoints — CRUD through HttpApiClient. Complements tenant
// isolation tests by exercising add → get → update → remove flows and
// the error paths (remove non-existent, remove static, etc.) within a
// single org.

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ScopeId } from "@executor/sdk";

import { asOrg } from "./__test-harness__/api-harness";

const MINIMAL_OPENAPI_SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Sources API Test", version: "1.0.0" },
  paths: {
    "/ping": {
      get: {
        operationId: "ping",
        summary: "ping",
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

describe("sources api (HTTP)", () => {
  it.effect("addSpec → sources.list includes the new namespace", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          const result = yield* client.openapi.addSpec({
            path: { scopeId: ScopeId.make(org) },
            payload: { spec: MINIMAL_OPENAPI_SPEC, namespace },
          });
          expect(result.namespace).toBe(namespace);
          expect(result.toolCount).toBeGreaterThan(0);
        }),
      );

      const sources = yield* asOrg(org, (client) =>
        client.sources.list({ path: { scopeId: ScopeId.make(org) } }),
      );
      expect(sources.map((s) => s.id)).toContain(namespace);
    }),
  );

  it.effect("openapi.getSource returns the stored source after addSpec", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        client.openapi.addSpec({
          path: { scopeId: ScopeId.make(org) },
          payload: { spec: MINIMAL_OPENAPI_SPEC, namespace },
        }),
      );

      const fetched = yield* asOrg(org, (client) =>
        client.openapi.getSource({ path: { scopeId: ScopeId.make(org), namespace } }),
      );
      expect(fetched).not.toBeNull();
      expect(fetched?.namespace).toBe(namespace);
    }),
  );

  it.effect("sources.remove deletes the source and it drops off sources.list", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            path: { scopeId: ScopeId.make(org) },
            payload: { spec: MINIMAL_OPENAPI_SPEC, namespace },
          });
          yield* client.sources.remove({
            path: { scopeId: ScopeId.make(org), sourceId: namespace },
          });
        }),
      );

      const after = yield* asOrg(org, (client) =>
        client.sources.list({ path: { scopeId: ScopeId.make(org) } }),
      );
      expect(after.map((s) => s.id)).not.toContain(namespace);
    }),
  );

  it.effect("sources.remove on a non-existent sourceId is a no-op (idempotent)", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const ghost = `missing_${crypto.randomUUID().slice(0, 8)}`;

      const result = yield* asOrg(org, (client) =>
        client.sources
          .remove({ path: { scopeId: ScopeId.make(org), sourceId: ghost } })
          .pipe(Effect.either),
      );
      expect(result._tag).toBe("Right");
    }),
  );

  it.effect("sources.remove on a static source is rejected", () =>
    Effect.gen(function* () {
      // `canRemove: false` is reserved for static (plugin-declared)
      // sources. The openapi plugin declares one with id "openapi"
      // for its control tools.
      const org = `org_${crypto.randomUUID()}`;

      const result = yield* asOrg(org, (client) =>
        client.sources
          .remove({ path: { scopeId: ScopeId.make(org), sourceId: "openapi" } })
          .pipe(Effect.either),
      );
      expect(result._tag).toBe("Left");
    }),
  );

  it.effect("openapi.updateSource round-trips baseUrl + name changes", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            path: { scopeId: ScopeId.make(org) },
            payload: { spec: MINIMAL_OPENAPI_SPEC, namespace },
          });
          yield* client.openapi.updateSource({
            path: { scopeId: ScopeId.make(org), namespace },
            payload: { name: "Renamed API", baseUrl: "https://override.example.com" },
          });
        }),
      );

      const fetched = yield* asOrg(org, (client) =>
        client.openapi.getSource({ path: { scopeId: ScopeId.make(org), namespace } }),
      );
      expect(fetched?.name).toBe("Renamed API");
      expect(fetched?.config.baseUrl).toBe("https://override.example.com");
    }),
  );
});

// Tenant isolation integration test. Runs in plain node (not workerd)
// via vitest.node.config.ts — workerd's dev-mode compile stack crashes
// on the full cloud module graph.

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ConnectionId, ScopeId, SecretId, ToolId } from "@executor/sdk";

import { ScopeForbidden } from "../auth/middleware";
import { asOrg, type ApiShape } from "./__test-harness__/api-harness";

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

  it.effect("sources.tools rejects cross-scope URLs with ScopeForbidden", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const namespaceA = `a_${crypto.randomUUID().replace(/-/g, "_")}`;

      // orgA installs a source with one `ping` tool.
      yield* asOrg(orgA, (client) =>
        client.openapi.addSpec({
          path: { scopeId: ScopeId.make(orgA) },
          payload: { spec: MINIMAL_OPENAPI_SPEC, namespace: namespaceA },
        }),
      );

      // Sanity: orgA itself can see the tool through the per-source
      // endpoint. If this drifts, the cross-org assertion below would
      // pass for the wrong reason (source never got written).
      const orgATools = yield* asOrg(orgA, (client) =>
        client.sources.tools({
          path: { scopeId: ScopeId.make(orgA), sourceId: namespaceA },
        }),
      );
      expect(orgATools.length).toBeGreaterThan(0);

      // The realistic IDOR attack: orgB authenticates with its own
      // session but crafts the URL with orgA's scopeId in the path.
      // `OrgAuth` must reject this with `ScopeForbidden` (403) before
      // the handler runs, so orgB never learns whether the source
      // exists in orgA.
      //
      // `Effect.flip` turns the typed error channel into the success
      // channel so we can match on it directly — if the call ever
      // starts succeeding, the test fails in the yield (nothing to
      // flip) rather than silently passing.
      const error = yield* asOrg(orgB, (client) =>
        Effect.flip(
          client.sources.tools({
            path: { scopeId: ScopeId.make(orgA), sourceId: namespaceA },
          }),
        ),
      );

      expect(error).toBeInstanceOf(ScopeForbidden);
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

  // One row per guarded endpoint. `assertScopeAccess` runs before any
  // lookup, so the dummy ids here never reach the DB — the request must
  // 403 purely from the path's `scopeId` not matching the caller's
  // session org. If someone deletes `yield* assertScopeAccess(...)` from
  // a handler, that handler's row fails (either different error class or
  // the call succeeds and `Effect.flip` has nothing to flip).
  const crossScopeCalls: ReadonlyArray<{
    readonly name: string;
    readonly call: (
      client: ApiShape,
      victimScopeId: ScopeId,
    ) => Effect.Effect<unknown, unknown, never>;
  }> = [
    { name: "tools.list", call: (c, s) => c.tools.list({ path: { scopeId: s } }) },
    {
      name: "tools.schema",
      call: (c, s) =>
        c.tools.schema({ path: { scopeId: s, toolId: ToolId.make("nope") } }),
    },
    { name: "sources.list", call: (c, s) => c.sources.list({ path: { scopeId: s } }) },
    {
      name: "sources.remove",
      call: (c, s) => c.sources.remove({ path: { scopeId: s, sourceId: "nope" } }),
    },
    {
      name: "sources.refresh",
      call: (c, s) => c.sources.refresh({ path: { scopeId: s, sourceId: "nope" } }),
    },
    {
      name: "sources.tools",
      call: (c, s) => c.sources.tools({ path: { scopeId: s, sourceId: "nope" } }),
    },
    {
      name: "sources.detect",
      call: (c, s) =>
        c.sources.detect({
          path: { scopeId: s },
          payload: { url: "https://example.com/spec.json" },
        }),
    },
    { name: "secrets.list", call: (c, s) => c.secrets.list({ path: { scopeId: s } }) },
    {
      name: "secrets.status",
      call: (c, s) =>
        c.secrets.status({ path: { scopeId: s, secretId: SecretId.make("nope") } }),
    },
    {
      name: "secrets.set",
      call: (c, s) =>
        c.secrets.set({
          path: { scopeId: s },
          payload: { id: SecretId.make("nope"), name: "nope", value: "nope" },
        }),
    },
    {
      name: "secrets.resolve",
      call: (c, s) =>
        c.secrets.resolve({ path: { scopeId: s, secretId: SecretId.make("nope") } }),
    },
    {
      name: "secrets.remove",
      call: (c, s) =>
        c.secrets.remove({ path: { scopeId: s, secretId: SecretId.make("nope") } }),
    },
    {
      name: "connections.list",
      call: (c, s) => c.connections.list({ path: { scopeId: s } }),
    },
    {
      name: "connections.remove",
      call: (c, s) =>
        c.connections.remove({
          path: { scopeId: s, connectionId: ConnectionId.make("nope") },
        }),
    },
  ];

  for (const { name, call } of crossScopeCalls) {
    it.effect(`${name} rejects cross-scope URL with ScopeForbidden`, () =>
      Effect.gen(function* () {
        const orgA = `org_${crypto.randomUUID()}`;
        const orgB = `org_${crypto.randomUUID()}`;
        const error = yield* asOrg(orgB, (client) =>
          Effect.flip(call(client, ScopeId.make(orgA))),
        );
        expect(error).toBeInstanceOf(ScopeForbidden);
      }),
    );
  }
});

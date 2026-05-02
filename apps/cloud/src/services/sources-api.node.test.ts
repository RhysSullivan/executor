// Source endpoints — CRUD through HttpApiClient. Complements tenant
// isolation tests by exercising add → get → update → remove flows and
// the error paths (remove non-existent, remove static, etc.) within a
// single org.

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import http from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { ScopeId, SecretId } from "@executor-js/sdk";

import {
  asOrg,
  asUser,
  testUserOrgScopeId,
} from "./__test-harness__/api-harness";

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

const invocableOpenApiSpec = (baseUrl: string) =>
  JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Invocable Source API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/echo/{message}": {
        get: {
          operationId: "echoMessage",
          summary: "Echo message",
          parameters: [
            {
              name: "message",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
            {
              name: "suffix",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      message: { type: "string" },
                      suffix: { type: "string" },
                      path: { type: "string" },
                    },
                    required: ["message", "path"],
                  },
                },
              },
            },
          },
        },
      },
    },
  });

const startEchoServer = () => {
  const requests: Array<{ readonly path: string; readonly suffix: string | null }> = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const match = /^\/echo\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    requests.push({
      path: url.pathname,
      suffix: url.searchParams.get("suffix"),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        message: decodeURIComponent(match[1]!),
        suffix: url.searchParams.get("suffix") ?? undefined,
        path: url.pathname,
      }),
    );
  });

  return new Promise<{
    readonly baseUrl: string;
    readonly requests: () => ReadonlyArray<{ readonly path: string; readonly suffix: string | null }>;
    readonly close: () => Promise<void>;
  }>((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveServer({
        baseUrl: `http://127.0.0.1:${port}`,
        requests: () => requests,
        close: () => new Promise((close) => server.close(() => close())),
      });
    });
  });
};

// The Cloudflare OpenAPI spec is the biggest real spec we care about:
// 16MB, 2700+ operations, thousands of shared schemas. Exercising
// addSpec end-to-end on it through the real postgres adapter is the
// load-bearing check that any adapter regression (per-row `createMany`,
// accidental N+1 reads, transaction snapshots that copy too much) will
// show up as a test failure instead of a prod incident.
const CLOUDFLARE_SPEC_PATH = resolve(
  __dirname,
  "../../../../packages/plugins/openapi/fixtures/cloudflare.json",
);
const CLOUDFLARE_SPEC = readFileSync(CLOUDFLARE_SPEC_PATH, "utf-8");

describe("sources api (HTTP)", () => {
  it.effect("addSpec → sources.list includes the new namespace", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          const result = yield* client.openapi.addSpec({
            params: { scopeId: ScopeId.make(org) },
            payload: { spec: MINIMAL_OPENAPI_SPEC, namespace },
          });
          expect(result.namespace).toBe(namespace);
          expect(result.toolCount).toBeGreaterThan(0);
        }),
      );

      const sources = yield* asOrg(org, (client) =>
        client.sources.list({ params: { scopeId: ScopeId.make(org) } }),
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
          params: { scopeId: ScopeId.make(org) },
          payload: { spec: MINIMAL_OPENAPI_SPEC, namespace },
        }),
      );

      const fetched = yield* asOrg(org, (client) =>
        client.openapi.getSource({ params: { scopeId: ScopeId.make(org), namespace } }),
      );
      expect(fetched).not.toBeNull();
      expect(fetched?.namespace).toBe(namespace);
    }),
  );

  it.effect("added OpenAPI source can be listed, inspected, and invoked through execution", () =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.promise(() => startEchoServer()),
        (fixture) => Effect.promise(() => fixture.close()),
      );
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;
      const scopeId = ScopeId.make(org);

      const addResult = yield* asOrg(org, (client) =>
        client.openapi.addSpec({
          params: { scopeId },
          payload: {
            spec: invocableOpenApiSpec(server.baseUrl),
            namespace,
          },
        }),
      );
      expect(addResult).toEqual({ namespace, toolCount: 1 });

      const fetched = yield* asOrg(org, (client) =>
        client.openapi.getSource({ params: { scopeId, namespace } }),
      );
      expect(fetched).toMatchObject({
        namespace,
        name: "Invocable Source API",
        config: { baseUrl: server.baseUrl },
      });

      const tools = yield* asOrg(org, (client) =>
        client.sources.tools({ params: { scopeId, sourceId: namespace } }),
      );
      const toolId = `${namespace}.echo.echoMessage`;
      expect(tools.map((tool) => tool.id)).toContain(toolId);

      const execution = yield* asOrg(org, (client) =>
        client.executions.execute({
          payload: {
            code: [
              `const result = await tools.${namespace}.echo.echoMessage({ message: "hello", suffix: "world" });`,
              "return result;",
            ].join("\n"),
          },
        }),
      );

      if (execution.status !== "completed") {
        throw new Error(`Expected completed execution, got ${execution.status}`);
      }
      expect(execution.isError).toBe(false);
      expect(execution.structured).toMatchObject({
        status: "completed",
        result: {
          message: "hello",
          suffix: "world",
          path: "/echo/hello",
        },
        logs: [],
      });
      expect(server.requests()).toEqual([{ path: "/echo/hello", suffix: "world" }]);
    }),
  );

  it.effect("mcp.getSource returns a persisted source even when discovery failed", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `mcp_${crypto.randomUUID().replace(/-/g, "_")}`;
      const scopeId = ScopeId.make(org);

      const addResult = yield* asOrg(org, (client) =>
        client.mcp
          .addSource({
            params: { scopeId },
            payload: {
              transport: "remote",
              name: "Broken MCP",
              endpoint: "http://127.0.0.1:1/mcp",
              remoteTransport: "auto",
              namespace,
            },
          })
          .pipe(Effect.result),
      );
      expect(addResult._tag).toBe("Failure");

      const fetched = yield* asOrg(org, (client) =>
        client.mcp.getSource({ params: { scopeId, namespace } }),
      );
      expect(fetched).toMatchObject({
        namespace,
        name: "Broken MCP",
        config: {
          transport: "remote",
          endpoint: "http://127.0.0.1:1/mcp",
          remoteTransport: "auto",
        },
      });

      const tools = yield* asOrg(org, (client) =>
        client.sources.tools({ params: { scopeId, sourceId: namespace } }),
      );
      expect(tools).toEqual([]);
    }),
  );

  it.effect("sources.remove deletes the source and it drops off sources.list", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            params: { scopeId: ScopeId.make(org) },
            payload: { spec: MINIMAL_OPENAPI_SPEC, namespace },
          });
          yield* client.sources.remove({
            params: { scopeId: ScopeId.make(org), sourceId: namespace },
          });
        }),
      );

      const after = yield* asOrg(org, (client) =>
        client.sources.list({ params: { scopeId: ScopeId.make(org) } }),
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
          .remove({ params: { scopeId: ScopeId.make(org), sourceId: ghost } })
          .pipe(Effect.result),
      );
      expect(result._tag).toBe("Success");
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
          .remove({ params: { scopeId: ScopeId.make(org), sourceId: "openapi" } })
          .pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("openapi.updateSource round-trips baseUrl + name changes", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.openapi.addSpec({
            params: { scopeId: ScopeId.make(org) },
            payload: { spec: MINIMAL_OPENAPI_SPEC, namespace },
          });
          yield* client.openapi.updateSource({
            params: { scopeId: ScopeId.make(org), namespace },
            payload: { name: "Renamed API", baseUrl: "https://override.example.com" },
          });
        }),
      );

      const fetched = yield* asOrg(org, (client) =>
        client.openapi.getSource({ params: { scopeId: ScopeId.make(org), namespace } }),
      );
      expect(fetched?.name).toBe("Renamed API");
      expect(fetched?.config.baseUrl).toBe("https://override.example.com");
    }),
  );

  it.effect("per-user source bindings isolate personal credentials over HTTP", () =>
    Effect.gen(function* () {
      const orgId = `org_${crypto.randomUUID()}`;
      const aliceId = `user_${crypto.randomUUID().slice(0, 8)}`;
      const bobId = `user_${crypto.randomUUID().slice(0, 8)}`;
      const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;
      const aliceScope = testUserOrgScopeId(aliceId, orgId);
      const bobScope = testUserOrgScopeId(bobId, orgId);

      yield* asOrg(orgId, (client) =>
        client.openapi.addSpec({
          params: { scopeId: ScopeId.make(orgId) },
          payload: {
            spec: MINIMAL_OPENAPI_SPEC,
            namespace,
            headers: {
              Authorization: {
                kind: "binding",
                slot: "auth:personal-token",
                prefix: "Bearer ",
              },
            },
          },
        }),
      );

      yield* asUser(aliceId, orgId, (client) =>
        Effect.gen(function* () {
          yield* client.secrets.set({
            params: { scopeId: ScopeId.make(aliceScope) },
            payload: {
              id: SecretId.make("alice_pat"),
              name: "Alice PAT",
              value: "alice-secret",
            },
          });
          yield* client.openapi.setSourceBinding({
            params: { scopeId: ScopeId.make(aliceScope) },
            payload: {
              sourceId: namespace,
              sourceScope: ScopeId.make(orgId),
              scope: ScopeId.make(aliceScope),
              slot: "auth:personal-token",
              value: {
                kind: "secret",
                secretId: SecretId.make("alice_pat"),
              },
            },
          });
        }),
      );

      yield* asUser(bobId, orgId, (client) =>
        Effect.gen(function* () {
          yield* client.secrets.set({
            params: { scopeId: ScopeId.make(bobScope) },
            payload: {
              id: SecretId.make("bob_pat"),
              name: "Bob PAT",
              value: "bob-secret",
            },
          });
          yield* client.openapi.setSourceBinding({
            params: { scopeId: ScopeId.make(bobScope) },
            payload: {
              sourceId: namespace,
              sourceScope: ScopeId.make(orgId),
              scope: ScopeId.make(bobScope),
              slot: "auth:personal-token",
              value: {
                kind: "secret",
                secretId: SecretId.make("bob_pat"),
              },
            },
          });
        }),
      );

      const aliceBindings = yield* asUser(aliceId, orgId, (client) =>
        client.openapi.listSourceBindings({
          params: {
            scopeId: ScopeId.make(aliceScope),
            namespace,
            sourceScopeId: ScopeId.make(orgId),
          },
        }),
      );
      expect(aliceBindings).toContainEqual(
        expect.objectContaining({
          scopeId: ScopeId.make(aliceScope),
          slot: "auth:personal-token",
          value: {
            kind: "secret",
            secretId: SecretId.make("alice_pat"),
          },
        }),
      );
      expect(
        aliceBindings.some(
          (binding) =>
            binding.slot === "auth:personal-token" &&
            binding.value.kind === "secret" &&
            binding.value.secretId === SecretId.make("bob_pat"),
        ),
      ).toBe(false);

      const bobBindings = yield* asUser(bobId, orgId, (client) =>
        client.openapi.listSourceBindings({
          params: {
            scopeId: ScopeId.make(bobScope),
            namespace,
            sourceScopeId: ScopeId.make(orgId),
          },
        }),
      );
      expect(bobBindings).toContainEqual(
        expect.objectContaining({
          scopeId: ScopeId.make(bobScope),
          slot: "auth:personal-token",
          value: {
            kind: "secret",
            secretId: SecretId.make("bob_pat"),
          },
        }),
      );
      expect(
        bobBindings.some(
          (binding) =>
            binding.slot === "auth:personal-token" &&
            binding.value.kind === "secret" &&
            binding.value.secretId === SecretId.make("alice_pat"),
        ),
      ).toBe(false);

      const sources = yield* asOrg(orgId, (client) =>
        client.sources.list({ params: { scopeId: ScopeId.make(orgId) } }),
      );
      expect(sources.find((source) => source.id === namespace)?.scopeId).toBe(
        ScopeId.make(orgId),
      );
    }),
  );

  it.effect(
    "addSpec persists the full Cloudflare spec through the real adapter",
    () =>
      Effect.gen(function* () {
        const org = `org_${crypto.randomUUID()}`;
        const namespace = `ns_${crypto.randomUUID().replace(/-/g, "_")}`;

        const result = yield* asOrg(org, (client) =>
          client.openapi.addSpec({
            params: { scopeId: ScopeId.make(org) },
            payload: { spec: CLOUDFLARE_SPEC, namespace },
          }),
        );
        expect(result.namespace).toBe(namespace);
        expect(result.toolCount).toBeGreaterThan(1000);

        const sources = yield* asOrg(org, (client) =>
          client.sources.list({ params: { scopeId: ScopeId.make(org) } }),
        );
        expect(sources.map((s) => s.id)).toContain(namespace);

        // removeSpec on the same size must also land cleanly — catches
        // symmetrical regressions on the delete side (e.g. deleteMany
        // fanning out to per-row deletes).
        yield* asOrg(org, (client) =>
          client.sources.remove({
            params: { scopeId: ScopeId.make(org), sourceId: namespace },
          }),
        );
        const after = yield* asOrg(org, (client) =>
          client.sources.list({ params: { scopeId: ScopeId.make(org) } }),
        );
        expect(after.map((s) => s.id)).not.toContain(namespace);
      }),
    // 60s is generous for a correct O(1) write path on local PGlite;
    // a per-row regression would take minutes and hit this ceiling
    // long before the suite would tolerate it.
    { timeout: 60_000 },
  );
});

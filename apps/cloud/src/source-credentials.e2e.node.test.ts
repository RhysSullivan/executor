// End-to-end coverage for shared source config + per-user credentials through
// the real cloud HTTP surface.
//
// This complements the SDK multi-scope tests by driving the actual cloud path:
//
//   HttpApiClient
//     -> ProtectedCloudApi
//     -> createScopedExecutor([userOrgScope, orgScope])
//     -> createExecutionEngine
//     -> executions.execute(code)
//     -> tools.<namespace>.* proxy
//     -> OpenAPI invoke
//
// Product invariant under test:
//
//   - one shared source row lives at org scope
//   - each user binds their own credential value at user-org scope
//   - invoking the same shared tool as different users sends different auth
//   - a user with no personal credential does not inherit someone else's

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import http from "node:http";
import { AddressInfo } from "node:net";

import { ScopeId, SecretId } from "@executor/sdk";

import { asUser, testUserOrgScopeId } from "./services/__test-harness__/api-harness";

const uniq = () => crypto.randomUUID().replace(/-/g, "_").slice(0, 8);
const nextOrgId = () => `org_src_${uniq()}`;
const nextUserId = () => `user_src_${uniq()}`;

const makeEchoSpec = (baseUrl: string) =>
  JSON.stringify({
    openapi: "3.0.0",
    info: {
      title: "Per-user credential echo",
      version: "1.0.0",
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/v1/projects/me": {
        get: {
          tags: ["projects"],
          operationId: "whoami",
          summary: "Echo the Authorization header",
          responses: {
            "200": {
              description: "Echo response",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      authorization: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

const serveEchoApi = () =>
  new Promise<{
    baseUrl: string;
    requestCount: () => number;
    seenAuth: () => readonly string[];
    close: () => Promise<void>;
  }>((resolve) => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(typeof req.headers.authorization === "string" ? req.headers.authorization : "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          authorization: req.headers.authorization ?? null,
        }),
      );
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requestCount: () => seen.length,
        seenAuth: () => seen,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });

describe("cloud shared-source per-user credentials (HTTP + executions)", () => {
  it.effect(
    "shared OpenAPI source uses each caller's own credential binding",
    () =>
      Effect.gen(function* () {
        const server = yield* Effect.promise(() => serveEchoApi());

        try {
          const orgId = nextOrgId();
          const aliceId = nextUserId();
          const bobId = nextUserId();
          const charlieId = nextUserId();
          const namespace = `vercel_${uniq()}`;
          const secretId = `vercel_api_token_${uniq()}`;
          const toolCall = `return await tools.${namespace}.projects.whoami({});`;

          // Shared source config lives at the org scope and carries only a
          // secret reference, not a token value.
          yield* asUser(aliceId, orgId, (client) =>
            client.openapi.addSpec({
              path: { scopeId: ScopeId.make(orgId) },
              payload: {
                spec: makeEchoSpec(server.baseUrl),
                namespace,
                headers: {
                  Authorization: {
                    secretId,
                    prefix: "Bearer ",
                  },
                },
              },
            }),
          );

          // Each user binds the same logical secret id at their own
          // user-within-org scope.
          yield* asUser(aliceId, orgId, (client) =>
            client.secrets.set({
              path: { scopeId: ScopeId.make(testUserOrgScopeId(aliceId, orgId)) },
              payload: {
                id: SecretId.make(secretId),
                name: "Alice Vercel Token",
                value: "alice-token",
              },
            }),
          );
          yield* asUser(bobId, orgId, (client) =>
            client.secrets.set({
              path: { scopeId: ScopeId.make(testUserOrgScopeId(bobId, orgId)) },
              payload: {
                id: SecretId.make(secretId),
                name: "Bob Vercel Token",
                value: "bob-token",
              },
            }),
          );

          // Both users see the same shared source row.
          const aliceSources = yield* asUser(aliceId, orgId, (client) =>
            client.sources.list({ path: { scopeId: ScopeId.make(orgId) } }),
          );
          const bobSources = yield* asUser(bobId, orgId, (client) =>
            client.sources.list({ path: { scopeId: ScopeId.make(orgId) } }),
          );
          expect(aliceSources.map((source) => source.id)).toContain(namespace);
          expect(bobSources.map((source) => source.id)).toContain(namespace);

          const aliceRun = yield* asUser(aliceId, orgId, (client) =>
            client.executions.execute({
              payload: { code: toolCall },
            }),
          );
          expect(aliceRun.status).toBe("completed");
          if (aliceRun.status !== "completed") {
            throw new Error("expected alice execution to complete");
          }
          expect(aliceRun.isError).toBe(false);
          expect((aliceRun.structured as { result: { authorization?: string } }).result.authorization)
            .toBe("Bearer alice-token");

          const bobRun = yield* asUser(bobId, orgId, (client) =>
            client.executions.execute({
              payload: { code: toolCall },
            }),
          );
          expect(bobRun.status).toBe("completed");
          if (bobRun.status !== "completed") {
            throw new Error("expected bob execution to complete");
          }
          expect(bobRun.isError).toBe(false);
          expect((bobRun.structured as { result: { authorization?: string } }).result.authorization)
            .toBe("Bearer bob-token");

          expect(server.seenAuth()).toEqual([
            "Bearer alice-token",
            "Bearer bob-token",
          ]);

          const requestsBeforeCharlie = server.requestCount();
          const charlieRun = yield* asUser(charlieId, orgId, (client) =>
            client.executions.execute({
              payload: { code: toolCall },
            }),
          );
          expect(charlieRun.status).toBe("completed");
          if (charlieRun.status !== "completed") {
            throw new Error("expected charlie execution to complete");
          }
          expect(charlieRun.isError).toBe(true);
          expect(charlieRun.text).toContain(secretId);
          expect(server.requestCount()).toBe(requestsBeforeCharlie);
        } finally {
          yield* Effect.promise(() => server.close());
        }
      }),
  );
});

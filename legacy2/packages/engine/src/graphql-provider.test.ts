import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it } from "@effect/vitest";
import { SourceSchema } from "@executor-v2/schema";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeGraphqlToolProvider } from "./graphql-provider";

const decodeSource = Schema.decodeUnknownSync(SourceSchema);

type TestServer = {
  endpoint: string;
  requests: Array<{
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }>;
  close: () => Promise<void>;
};

class GraphqlProviderTestServerReleaseError extends Data.TaggedError(
  "GraphqlProviderTestServerReleaseError",
)<{
  message: string;
}> {}

const getHeader = (request: IncomingMessage, key: string): string | null => {
  const value = request.headers[key];
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return null;
};

const json = (response: ServerResponse, body: unknown): void => {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
};

const makeGraphqlTestServer = Effect.acquireRelease(
  Effect.promise<TestServer>(
    () =>
      new Promise<TestServer>((resolve, reject) => {
        const requests: TestServer["requests"] = [];

        const server = createServer(async (request, response) => {
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.end();
            return;
          }

          const chunks: Array<Buffer> = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }

          const rawBody = Buffer.concat(chunks).toString("utf8");
          const parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
          requests.push({
            headers: {
              "x-api-key": getHeader(request, "x-api-key") ?? "",
              "x-extra": getHeader(request, "x-extra") ?? "",
            },
            body: parsedBody,
          });

          const query = typeof parsedBody.query === "string" ? parsedBody.query : "";
          if (query.includes("errorCase")) {
            json(response, {
              errors: [{ message: "boom" }],
            });
            return;
          }

          json(response, {
            data: {
              ok: true,
            },
          });
        });

        server.once("error", (error) => reject(error));
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Failed to resolve GraphQL test server address"));
            return;
          }

          resolve({
            endpoint: `http://127.0.0.1:${address.port}/graphql`,
            requests,
            close: () =>
              new Promise<void>((closeResolve, closeReject) => {
                server.close((error) => {
                  if (error) {
                    closeReject(error);
                    return;
                  }
                  closeResolve();
                });
              }),
          });
        });
      }),
  ),
  (server) =>
    Effect.tryPromise({
      try: () => server.close(),
      catch: (cause) =>
        new GraphqlProviderTestServerReleaseError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(Effect.orDie),
);

describe("makeGraphqlToolProvider", () => {
  it.scoped("discovers a request tool and invokes GraphQL operations", () =>
    Effect.gen(function* () {
      const testServer = yield* makeGraphqlTestServer;
      const provider = makeGraphqlToolProvider();

      const source = decodeSource({
        id: "src_graphql",
        workspaceId: "ws_local",
        name: "GraphQL Source",
        kind: "graphql",
        endpoint: "https://fallback.example/graphql",
        status: "connected",
        enabled: true,
        configJson: JSON.stringify({
          endpoint: testServer.endpoint,
          headers: {
            "x-api-key": "secret",
          },
        }),
        sourceHash: "source_hash",
        lastError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const discovered = yield* provider.discoverFromSource!(source);
      expect(discovered.sourceHash).toBe("source_hash");
      expect(discovered.tools).toHaveLength(1);
      expect(discovered.tools[0]?.toolId).toBe("request");

      const tool = discovered.tools[0]!;
      const success = yield* provider.invoke({
        source,
        tool,
        args: {
          query: "query viewer { viewer { id } }",
          variables: {
            includePrivate: false,
          },
          operationName: "viewer",
          headers: {
            "x-extra": "extra",
          },
        },
      });

      expect(success.isError).toBe(false);
      expect(success.output).toMatchObject({
        status: 200,
        body: {
          data: {
            ok: true,
          },
        },
      });

      const failing = yield* provider.invoke({
        source,
        tool,
        args: {
          query: "query errorCase { viewer { id } }",
        },
      });

      expect(failing.isError).toBe(true);
      expect(failing.output).toMatchObject({
        status: 200,
        body: {
          errors: [{ message: "boom" }],
        },
      });

      expect(testServer.requests).toHaveLength(2);
      expect(testServer.requests[0]?.headers["x-api-key"]).toBe("secret");
      expect(testServer.requests[0]?.headers["x-extra"]).toBe("extra");
      expect(testServer.requests[0]?.body).toMatchObject({
        query: "query viewer { viewer { id } }",
        variables: {
          includePrivate: false,
        },
        operationName: "viewer",
      });
    }),
  );
});

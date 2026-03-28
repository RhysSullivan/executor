import {
  createServer,
  type IncomingMessage,
} from "node:http";

import {
  afterEach,
  describe,
  expect,
  it,
} from "@effect/vitest";

import {
  createGraphqlToolFromPersistedOperation,
} from "./graphql-tools";

type CapturedRequest = {
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
};

const requestHeadersFromNode = (
  request: IncomingMessage,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(request.headers).flatMap(([key, value]) =>
      value === undefined
        ? []
        : [[key, Array.isArray(value) ? value.join(",") : value]]),
  );

const makeServer = async () => {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "127.0.0.1"}`,
    );
    let body = "";

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        path: url.pathname,
        query: url.search,
        headers: requestHeadersFromNode(request),
        body,
      });
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { viewer: { id: "usr_123" } } }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/graphql`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
};

describe("graphql-tools", () => {
  const resources: Array<Awaited<ReturnType<typeof makeServer>>> = [];

  afterEach(async () => {
    while (resources.length > 0) {
      await resources.pop()?.close();
    }
  });

  it("applies credential placements for query params, cookies, and body values", async () => {
    const server = await makeServer();
    resources.push(server);

    const toolInput = createGraphqlToolFromPersistedOperation({
      path: "source.graphql.raw",
      sourceKey: "src_graphql",
      endpoint: server.baseUrl,
      providerData: {
        kind: "graphql",
        toolKind: "request",
        toolId: "raw",
        rawToolId: null,
        group: null,
        leaf: null,
        fieldName: null,
        operationType: "query",
        operationName: null,
        operationDocument: null,
        queryTypeName: "Query",
        mutationTypeName: "Mutation",
        subscriptionTypeName: null,
      },
      credentialPlacements: {
        headers: {
          authorization: "Token top-secret",
        },
        queryParams: {
          tenant: "acme",
        },
        cookies: {
          session: "abc123",
        },
        bodyValues: {
          "extensions.clientVersion": "v1.0.0",
        },
      },
    });
    const execute =
      typeof toolInput === "object" && toolInput !== null && "tool" in toolInput
        ? toolInput.tool.execute
        : (() => {
            throw new Error("Expected GraphQL tool definition");
          });

    const result = await Promise.resolve(
      execute({
        query: "query Viewer { viewer { id } }",
      }),
    );

    expect(result).toEqual({
      status: 200,
      headers: expect.any(Object),
      body: { data: { viewer: { id: "usr_123" } } },
      isError: false,
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.query).toContain("tenant=acme");
    expect(server.requests[0]?.headers.authorization).toBe("Token top-secret");
    expect(server.requests[0]?.headers.cookie).toContain("session=abc123");
    expect(JSON.parse(server.requests[0]?.body ?? "{}")).toEqual({
      query: "query Viewer { viewer { id } }",
      extensions: {
        clientVersion: "v1.0.0",
      },
    });
  });
});

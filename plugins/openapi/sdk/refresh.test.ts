import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
} from "@effect/platform";
import {
  startOpenApiTestServer,
} from "@executor/effect-test-utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  describe,
  expect,
  it,
} from "vitest";

import type {
  OpenApiStoredSourceData,
} from "@executor/plugin-openapi-shared";
import type {
  Source,
} from "../../../packages/platform/sdk/src/schema/models/source";
import {
  ScopeIdSchema,
  SourceIdSchema,
} from "../../../packages/platform/sdk/src/schema/ids";
import {
  openApiSdkPlugin,
} from "./index";

class DemoApiGroup extends HttpApiGroup.make("demo").add(
  HttpApiEndpoint.get("listWidgets")`/widgets`.addSuccess(
    Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
        }),
      ),
    }),
  ),
) {}

class DemoApi extends HttpApi.make("demo").add(DemoApiGroup) {}

const demoApiLayer = HttpApiBuilder.api(DemoApi).pipe(
  Layer.provide(
    HttpApiBuilder.group(DemoApi, "demo", (handlers) =>
      handlers.handle("listWidgets", () =>
        Effect.succeed({
          items: [
            {
              id: "widget_1",
              name: "Primary widget",
            },
          ],
        })
      )
    ),
  ),
);

const headerValue = (value: string | string[] | undefined): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

const createConditionalSpecHandler = (input: {
  contentText: string;
  etag: string;
  requests: Array<string | null>;
}) => (request: IncomingMessage, response: ServerResponse) => {
  if (request.url !== "/openapi.json") {
    response.writeHead(404);
    response.end("Not Found");
    return;
  }

  const ifNoneMatch = headerValue(request.headers["if-none-match"]);
  input.requests.push(ifNoneMatch);

  if (ifNoneMatch === input.etag) {
    response.writeHead(304, {
      ETag: input.etag,
    });
    response.end();
    return;
  }

  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    ETag: input.etag,
  });
  response.end(input.contentText);
};

const startConditionalSpecServer = async (input: {
  contentText: string;
  etag: string;
  requests: Array<string | null>;
}) => {
  const server = createServer(createConditionalSpecHandler(input));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to determine conditional spec server address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
};

const testSource: Source = {
  id: SourceIdSchema.make("vercel-api"),
  scopeId: ScopeIdSchema.make("ws_local_0704354896a696c6"),
  name: "Vercel API",
  kind: "openapi",
  status: "connected",
  enabled: true,
  namespace: "vercel-api",
  createdAt: 0,
  updatedAt: 0,
};

describe("openapi refresh", () => {
  it("retries without etag when the spec endpoint returns 304", async () => {
    const upstream = await startOpenApiTestServer({
      apiLayer: demoApiLayer,
    });

    try {
      const upstreamSpecResponse = await fetch(upstream.specUrl);
      const contentText = await upstreamSpecResponse.text();
      const requests: Array<string | null> = [];
      const etag = "\"demo-openapi-etag\"";
      const conditionalServer = await startConditionalSpecServer({
        contentText,
        etag,
        requests,
      });

      try {
        let stored: OpenApiStoredSourceData = {
          specUrl: `${conditionalServer.baseUrl}/openapi.json`,
          baseUrl: null,
          auth: {
            kind: "none" as const,
          },
          defaultHeaders: null,
          etag,
          lastSyncAt: 0,
        };

        const plugin = openApiSdkPlugin({
          storage: {
            get: () => Effect.succeed(stored),
            put: ({ value }) =>
              Effect.sync(() => {
                stored = value;
              }),
          },
        });
        const runtime = plugin.sources?.[0];

        expect(runtime).toBeDefined();

        const result = await Effect.runPromise(
          runtime!.getIrModel({
            source: testSource,
          }) as Effect.Effect<any, Error, never>,
        );

        expect(result.sourceHash).toBeTruthy();
        expect(requests).toEqual([etag, null]);
        expect(stored.etag).toBe(etag);
        expect(stored.lastSyncAt).toBeGreaterThan(0);
      } finally {
        await conditionalServer.close();
      }
    } finally {
      await upstream.close();
    }
  });
});

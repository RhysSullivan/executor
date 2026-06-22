import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";
import { Api, Target, Telemetry } from "../src/services";

const api = composePluginApi([openApiHttpPlugin()] as const);

const upstreamSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Cell Telemetry Upstream", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/ok": {
        get: {
          operationId: "ok",
          summary: "Succeeds",
          tags: ["probe"],
          responses: { "200": { description: "" } },
        },
      },
    },
  });

const serveUpstream = Effect.acquireRelease(
  Effect.callback<{ readonly baseUrl: string; readonly close: () => void }>((resume) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"fine":true}');
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resume(
        Effect.succeed({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => {
            server.close();
            server.closeAllConnections();
          },
        }),
      );
    });
  }),
  (server) => Effect.sync(server.close),
);

scenario(
  "Code mode cell tool calls carry trace correlation metadata",
  { timeout: 180_000 },
  Effect.scoped(
    Effect.gen(function* () {
      const target = yield* Target;
      const { client: apiClient } = yield* Api;
      const telemetry = yield* Telemetry;
      const identity = yield* target.newIdentity();
      const client = yield* apiClient(api, identity);
      const upstream = yield* serveUpstream;

      const slug = IntegrationSlug.make(`celltrace${randomBytes(4).toString("hex")}`);
      yield* client.openapi.addSpec({
        payload: {
          spec: { kind: "blob", value: upstreamSpec(upstream.baseUrl) },
          slug,
          baseUrl: upstream.baseUrl,
          authenticationTemplate: [
            {
              slug: "apiKey",
              type: "apiKey",
              headers: { Authorization: ["Bearer ", { type: "variable", name: "token" }] },
            },
          ],
        },
      });
      yield* client.connections.create({
        payload: {
          owner: "org",
          name: ConnectionName.make("main"),
          integration: slug,
          template: AuthTemplateSlug.make("apiKey"),
          value: "cell-telemetry-token",
        },
      });

      const tools = yield* client.tools.list({ query: {} });
      const tool = tools.find(
        (entry) =>
          String(entry.integration) === String(slug) && String(entry.address).endsWith(".ok"),
      );
      expect(tool, "the OpenAPI operation is in the tool catalog").toBeDefined();
      const address = String(tool!.address);
      const path = address.startsWith("tools.") ? address.slice("tools.".length) : address;

      const specResponse = yield* Effect.promise(() =>
        fetch(new URL("/api/openapi.json", target.baseUrl)),
      );
      const spec = (yield* Effect.promise(() => specResponse.json())) as {
        readonly paths?: Record<string, unknown>;
      };
      expect(Object.keys(spec.paths ?? {}), "the cell API is documented").toContain(
        "/api/execution-cells",
      );

      const cellResponse = yield* Effect.promise(() =>
        fetch(new URL("/api/execution-cells", target.baseUrl), {
          method: "POST",
          headers: {
            ...(identity.headers ?? {}),
            "content-type": "application/json",
            origin: new URL(target.baseUrl).origin,
          },
          body: JSON.stringify({
            yieldAfterMs: 5_000,
            code: `return await tools.${path}({});`,
          }),
        }),
      );
      const cellBody = yield* Effect.promise(() => cellResponse.text());
      expect(cellResponse.status, `startCell response body: ${cellBody.slice(0, 500)}`).toBe(200);
      const cell = JSON.parse(cellBody) as {
        readonly status?: unknown;
        readonly cellId?: unknown;
      };
      expect(cell.status, "a one-shot tool call cell completes").toBe("completed");
      expect(cell.cellId, "the completed cell response includes a cell id").toEqual(
        expect.any(String),
      );

      const span = yield* telemetry.expectSpan({
        operation: "executor.code.cell.tool",
        attributes: {
          "executor.tool.source": "code_cell",
          "executor.tool.path": path,
        },
      });
      expect(
        span.span.tags["executor.code.cell_id"],
        "the cell tool span carries a cell id",
      ).toBeTruthy();
    }),
  ),
);

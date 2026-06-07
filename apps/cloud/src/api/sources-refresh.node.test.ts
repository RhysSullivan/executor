// Connection refresh endpoint — covers `connections.refresh(ref)` (v2).
//
// In v2 tools are produced per-connection by the owning plugin's `resolveTools`.
// `connections.refresh` re-runs that hook: for MCP it re-dials the live server
// (so a server-side tool change is picked up), and the integration's
// `canRefresh` flag reflects whether the catalog row can be refreshed at all
// (openapi-from-URL → true; openapi-from-blob → false).

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk";
import {
  makeOpenApiHttpApiTestSpecPayload,
  serveMutableOpenApiSpecTestServer,
} from "@executor-js/plugin-openapi/testing";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";

import { asOrg } from "../testing/api-harness";

const PingEndpoint = HttpApiEndpoint.get("ping", "/ping", { success: Schema.Unknown });

const RefreshApi = HttpApi.make("refreshFixture")
  .add(HttpApiGroup.make("default", { topLevel: true }).add(PingEndpoint))
  .annotateMerge(OpenApi.annotations({ title: "Refresh Fixture", version: "1.0.0" }));

const makeRefreshSpecText = () => makeOpenApiHttpApiTestSpecPayload(RefreshApi).spec;

const NAME_MAIN = ConnectionName.make("main");
const TEMPLATE_NONE = AuthTemplateSlug.make("none");

describe("connections.refresh (HTTP)", () => {
  it.effect("refresh re-dials the MCP server and updates per-connection tools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let toolName = "before_refresh";
        const server = yield* serveMcpServer(() =>
          makeGreetingMcpServer({ name: "refresh-mcp", toolName, text: "ok" }),
        );
        const org = `org_${crypto.randomUUID()}`;
        const slug = IntegrationSlug.make(`mcp_${crypto.randomUUID().replace(/-/g, "_")}`);

        yield* asOrg(org, (client) =>
          client.mcp.addServer({
            payload: {
              transport: "remote",
              name: "Refresh MCP",
              endpoint: server.endpoint,
              remoteTransport: "streamable-http",
              slug,
            },
          }),
        );

        yield* asOrg(org, (client) =>
          client.connections.create({
            payload: {
              owner: "org",
              name: NAME_MAIN,
              integration: slug,
              template: TEMPLATE_NONE,
              value: "unused",
            },
          }),
        );

        const before = yield* asOrg(org, (client) =>
          client.tools.list({ query: { integration: slug } }),
        );
        expect(before.map((t) => t.address)).toContain(`tools.${slug}.org.main.before_refresh`);
        expect(before.map((t) => t.address)).not.toContain(`tools.${slug}.org.main.after_refresh`);

        // Flip the live server's tool name and refresh the connection.
        toolName = "after_refresh";
        const refreshed = yield* asOrg(org, (client) =>
          client.connections.refresh({
            params: { owner: "org", integration: slug, name: NAME_MAIN },
          }),
        );
        expect(refreshed.some((t) => t.address.endsWith(".after_refresh"))).toBe(true);

        const after = yield* asOrg(org, (client) =>
          client.tools.list({ query: { integration: slug } }),
        );
        expect(after.map((t) => t.address)).not.toContain(`tools.${slug}.org.main.before_refresh`);
        expect(after.map((t) => t.address)).toContain(`tools.${slug}.org.main.after_refresh`);
      }),
    ),
  );

  it.effect("openapi-from-URL integration reports canRefresh:true", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* serveMutableOpenApiSpecTestServer({ initialApi: RefreshApi });
        const org = `org_${crypto.randomUUID()}`;
        const slug = IntegrationSlug.make(`ns_${crypto.randomUUID().replace(/-/g, "_")}`);

        yield* asOrg(org, (client) =>
          client.openapi.addSpec({
            payload: {
              spec: { kind: "url", url: server.specUrl },
              slug,
              baseUrl: server.baseUrl,
            },
          }),
        );

        const integration = yield* asOrg(org, (client) =>
          client.integrations.get({ params: { slug } }),
        );
        expect(integration?.canRefresh).toBe(true);
      }),
    ),
  );

  it.effect("openapi-from-blob integration reports canRefresh:false", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const slug = IntegrationSlug.make(`ns_${crypto.randomUUID().replace(/-/g, "_")}`);

      yield* asOrg(org, (client) =>
        client.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: makeRefreshSpecText() },
            slug,
            baseUrl: "https://api.example.test",
          },
        }),
      );

      const integration = yield* asOrg(org, (client) =>
        client.integrations.get({ params: { slug } }),
      );
      expect(integration?.canRefresh).toBe(false);
    }),
  );
});

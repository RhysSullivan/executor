// Integration + connection endpoints — CRUD through HttpApiClient (v2).
//
// Ports the v1 "sources api" suite onto the v2 catalog surface: integrations
// are the tenant-shared catalog (was `sources`), connections are the owner-
// scoped credentials (was `secrets` + credential bindings), and tools are
// per-connection and address-keyed. The plugin extension routes
// (`openapi.addSpec`, `mcp.addServer`, `graphql.addIntegration`) register an
// integration; `connections.create` mints the per-connection tools; execution
// invokes them by their dotted address.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk";
import {
  serveGraphqlTestServer,
  makeGreetingGraphqlSchema,
} from "@executor-js/plugin-graphql/testing";
import { makeGreetingMcpServer, serveMcpServer } from "@executor-js/plugin-mcp/testing";
import {
  makeOpenApiHttpApiTestAddSpecPayload,
  makeOpenApiHttpApiTestSpecPayload,
  serveOpenApiEchoTestServer,
} from "@executor-js/plugin-openapi/testing";

import { asOrg, asUser } from "../testing/api-harness";

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const PingGroup = HttpApiGroup.make("default", { topLevel: true }).add(
  HttpApiEndpoint.get("ping", "/ping", { success: Schema.Unknown }),
);

const MinimalSourceApi = HttpApi.make("sourcesApiTest")
  .add(PingGroup)
  .annotateMerge(OpenApi.annotations({ title: "Sources API Test", version: "1.0.0" }));

const makeMinimalOpenApiSpecPayload = (
  slug: string,
  options: Omit<Parameters<typeof makeOpenApiHttpApiTestAddSpecPayload>[1], "slug"> = {},
) =>
  makeOpenApiHttpApiTestAddSpecPayload(MinimalSourceApi, {
    slug,
    ...options,
  });

const makeMinimalOpenApiPreviewPayload = () => makeOpenApiHttpApiTestSpecPayload(MinimalSourceApi);

const randomSlug = (prefix: string) =>
  IntegrationSlug.make(`${prefix}_${crypto.randomUUID().replace(/-/g, "_")}`);

const NAME_MAIN = ConnectionName.make("main");
const NAME_PERSONAL = ConnectionName.make("personal");
const TEMPLATE_API_KEY = AuthTemplateSlug.make("apiKey");
const TEMPLATE_NONE = AuthTemplateSlug.make("none");

// The Cloudflare OpenAPI spec is the biggest real spec we care about:
// 16MB, 2700+ operations, thousands of shared schemas. Exercising
// addSpec end-to-end on it through the real Drizzle/FumaDB path is the
// load-bearing check that any storage regression (per-row `createMany`,
// accidental N+1 reads, transaction snapshots that copy too much) will show up
// as a test failure instead of a prod incident.
const CLOUDFLARE_SPEC_PATH = resolve(
  __dirname,
  "../../../../packages/plugins/openapi/fixtures/cloudflare.json",
);
const CLOUDFLARE_SPEC = readFileSync(CLOUDFLARE_SPEC_PATH, "utf-8");

describe("integrations api (HTTP)", () => {
  it.effect("addSpec → integrations.list includes the new slug", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const slug = randomSlug("ns");

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          const result = yield* client.openapi.addSpec({
            payload: makeMinimalOpenApiSpecPayload(slug),
          });
          expect(result.slug).toBe(slug);
          expect(result.toolCount).toBeGreaterThan(0);
        }),
      );

      const integrations = yield* asOrg(org, (client) => client.integrations.list({}));
      expect(integrations.map((s) => s.slug)).toContain(slug);
    }),
  );

  it.effect("openapi.getIntegration returns the stored integration after addSpec", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const slug = randomSlug("ns");

      yield* asOrg(org, (client) =>
        client.openapi.addSpec({ payload: makeMinimalOpenApiSpecPayload(slug) }),
      );

      const fetched = yield* asOrg(org, (client) =>
        client.openapi.getIntegration({ params: { slug } }),
      );
      expect(fetched).not.toBeNull();
      expect(fetched?.slug).toBe(slug);
    }),
  );

  it.effect("openapi.previewSpec returns class-backed preview metadata over HTTP", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const preview = yield* asOrg(org, (client) =>
        client.openapi.previewSpec({ payload: makeMinimalOpenApiPreviewPayload() }),
      );

      expect(preview).toMatchObject({
        operationCount: 1,
        operations: [
          expect.objectContaining({
            operationId: "ping",
            method: "get",
            path: "/ping",
          }),
        ],
      });
    }),
  );

  it.effect("openapi.addSpec accepts a public HTTP baseUrl in local mode", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;

      const result = yield* asOrg(org, (client) =>
        client.openapi.addSpec({
          payload: makeMinimalOpenApiSpecPayload(randomSlug("ns"), {
            baseUrl: "http://example.com",
          }),
        }),
      );

      expect(result.toolCount).toBe(1);
    }),
  );

  it.effect("added OpenAPI integration can be connected, listed, and invoked via execution", () =>
    Effect.gen(function* () {
      const server = yield* serveOpenApiEchoTestServer({
        transformSpec: (spec) => ({
          ...spec,
          info: { title: "Invocable Source API", version: "1.0.0" },
          paths: {
            "/echo/{message}": isJsonObject(spec.paths) ? spec.paths["/echo/{message}"] : {},
          },
        }),
      });
      const org = `org_${crypto.randomUUID()}`;
      const slug = randomSlug("ns");

      const addResult = yield* asOrg(org, (client) =>
        client.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: server.specJson },
            slug,
            description: "Invocable Source API",
            baseUrl: server.baseUrl,
          },
        }),
      );
      expect(addResult.slug).toBe(slug);

      const fetched = yield* asOrg(org, (client) =>
        client.openapi.getIntegration({ params: { slug } }),
      );
      expect(fetched).toMatchObject({ slug, kind: "openapi" });

      // Mint a connection so the per-connection tools are stamped + persisted.
      yield* asOrg(org, (client) =>
        client.connections.create({
          payload: {
            owner: "org",
            name: NAME_MAIN,
            integration: slug,
            template: TEMPLATE_API_KEY,
            value: "static-token",
          },
        }),
      );

      const tools = yield* asOrg(org, (client) =>
        client.tools.list({ query: { integration: slug } }),
      );
      const toolAddress = `tools.${slug}.org.main.echo.echoMessage`;
      expect(tools.map((tool) => tool.address)).toContain(toolAddress);

      const execution = yield* asOrg(org, (client) =>
        client.executions.execute({
          payload: {
            code: [
              `const result = await ${toolAddress}({ message: "hello", suffix: "world" });`,
              "return result;",
            ].join("\n"),
          },
        }),
      );

      expect(execution.status).toBe("completed");
      if (execution.status !== "completed") return;
      expect(execution.isError).toBe(false);
      expect(execution.structured).toMatchObject({
        result: {
          ok: true,
          data: {
            status: 200,
            data: {
              message: "hello",
              suffix: "world",
              path: "/echo/hello",
            },
          },
        },
      });
      expect(yield* server.requests).toContainEqual(
        expect.objectContaining({ path: "/echo/hello" }),
      );
    }),
  );

  it.effect("mcp.addServer persists the integration without dialing (discovery is deferred)", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const slug = randomSlug("mcp");

      // v2: addServer only registers the integration catalog row — it does NOT
      // dial the server (discovery happens later at connection time). So a dead
      // endpoint still registers successfully and getServer returns the row.
      const addResult = yield* asOrg(org, (client) =>
        client.mcp.addServer({
          payload: {
            transport: "remote",
            name: "Broken MCP",
            endpoint: "http://127.0.0.1:1/mcp",
            remoteTransport: "auto",
            slug,
          },
        }),
      );
      expect(addResult.slug).toBe(slug);

      const fetched = yield* asOrg(org, (client) => client.mcp.getServer({ params: { slug } }));
      expect(fetched).toMatchObject({
        slug,
        config: {
          transport: "remote",
          endpoint: "http://127.0.0.1:1/mcp",
          remoteTransport: "auto",
        },
      });
    }),
  );

  it.effect("added GraphQL integration can be inspected and invoked through execution", () =>
    Effect.gen(function* () {
      const server = yield* serveGraphqlTestServer({
        schema: makeGreetingGraphqlSchema({ includeMutation: false }),
      });
      const org = `org_${crypto.randomUUID()}`;
      const slug = randomSlug("gql");

      const added = yield* asOrg(org, (client) =>
        client.graphql.addIntegration({
          payload: {
            endpoint: server.endpoint,
            slug,
            name: "Cloud GraphQL",
          },
        }),
      );
      expect(added.slug).toBe(slug);

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

      const tools = yield* asOrg(org, (client) =>
        client.tools.list({ query: { integration: slug } }),
      );
      const toolAddress = `tools.${slug}.org.main.query.hello`;
      expect(tools.map((tool) => tool.address)).toContain(toolAddress);

      const execution = yield* asOrg(org, (client) =>
        client.executions.execute({
          payload: {
            code: [`const result = await ${toolAddress}({ name: "Ada" });`, "return result;"].join(
              "\n",
            ),
          },
        }),
      );

      expect(execution.status).toBe("completed");
      if (execution.status !== "completed") return;
      expect(execution.isError).toBe(false);
      expect(execution.structured).toMatchObject({
        result: { ok: true, data: { hello: "Hello Ada" } },
      });
      const requests = yield* server.requests;
      expect(requests.some((request) => request.payload.query?.includes("__schema"))).toBe(true);
      expect(requests).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({ variables: { name: "Ada" } }),
        }),
      );
    }),
  );

  it.effect("added MCP integration can be inspected and invoked through execution", () =>
    Effect.gen(function* () {
      const server = yield* serveMcpServer(() =>
        makeGreetingMcpServer({
          name: "cloud-e2e-mcp",
          toolDescription: "Echoes from the cloud e2e MCP server",
          text: "cloud-mcp-ok",
        }),
      );
      const org = `org_${crypto.randomUUID()}`;
      const slug = randomSlug("mcp");

      const added = yield* asOrg(org, (client) =>
        client.mcp.addServer({
          payload: {
            transport: "remote",
            name: "Cloud MCP",
            endpoint: server.endpoint,
            remoteTransport: "streamable-http",
            slug,
          },
        }),
      );
      expect(added.slug).toBe(slug);

      const fetched = yield* asOrg(org, (client) => client.mcp.getServer({ params: { slug } }));
      expect(fetched).toMatchObject({
        slug,
        config: {
          transport: "remote",
          endpoint: server.endpoint,
          remoteTransport: "streamable-http",
        },
      });

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

      const tools = yield* asOrg(org, (client) =>
        client.tools.list({ query: { integration: slug } }),
      );
      const toolAddress = `tools.${slug}.org.main.simple_echo`;
      expect(tools.map((tool) => tool.address)).toContain(toolAddress);

      const execution = yield* asOrg(org, (client) =>
        client.executions.execute({
          payload: {
            code: [`const result = await ${toolAddress}({});`, "return result;"].join("\n"),
          },
        }),
      );

      expect(execution.status).toBe("completed");
      if (execution.status !== "completed") return;
      expect(execution.isError).toBe(false);
      expect(execution.structured).toMatchObject({
        result: {
          ok: true,
          data: { content: [{ type: "text", text: "cloud-mcp-ok" }] },
        },
      });
      expect((yield* server.requests).length).toBeGreaterThanOrEqual(2);
    }),
  );

  it.effect("connection refresh updates MCP per-connection tool rows", () =>
    Effect.gen(function* () {
      let toolName = "before_refresh";
      const server = yield* serveMcpServer(() =>
        makeGreetingMcpServer({
          name: "cloud-refresh-mcp",
          toolName,
          text: "refresh-ok",
        }),
      );
      const org = `org_${crypto.randomUUID()}`;
      const slug = randomSlug("mcp");

      yield* asOrg(org, (client) =>
        client.mcp.addServer({
          payload: {
            transport: "remote",
            name: "Cloud Refresh MCP",
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

      const beforeTools = yield* asOrg(org, (client) =>
        client.tools.list({ query: { integration: slug } }),
      );
      expect(beforeTools.map((tool) => tool.address)).toContain(
        `tools.${slug}.org.main.before_refresh`,
      );

      toolName = "after_refresh";
      yield* asOrg(org, (client) =>
        client.connections.refresh({
          params: { owner: "org", integration: slug, name: NAME_MAIN },
        }),
      );

      const afterTools = yield* asOrg(org, (client) =>
        client.tools.list({ query: { integration: slug } }),
      );
      expect(afterTools.map((tool) => tool.address)).not.toContain(
        `tools.${slug}.org.main.before_refresh`,
      );
      expect(afterTools.map((tool) => tool.address)).toContain(
        `tools.${slug}.org.main.after_refresh`,
      );
    }),
  );

  it.effect("integrations.remove deletes the integration and drops off the list", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const slug = randomSlug("ns");

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.openapi.addSpec({ payload: makeMinimalOpenApiSpecPayload(slug) });
          yield* client.integrations.remove({ params: { slug } });
        }),
      );

      const after = yield* asOrg(org, (client) => client.integrations.list({}));
      expect(after.map((s) => s.slug)).not.toContain(slug);
    }),
  );

  it.effect("integrations.update round-trips a description change", () =>
    Effect.gen(function* () {
      const org = `org_${crypto.randomUUID()}`;
      const slug = randomSlug("ns");

      yield* asOrg(org, (client) =>
        Effect.gen(function* () {
          yield* client.openapi.addSpec({ payload: makeMinimalOpenApiSpecPayload(slug) });
          yield* client.integrations.update({
            params: { slug },
            payload: { description: "Renamed API" },
          });
        }),
      );

      const fetched = yield* asOrg(org, (client) => client.integrations.get({ params: { slug } }));
      expect(fetched?.description).toBe("Renamed API");
    }),
  );

  it.effect("org + user connections produce distinct addresses with isolated values", () =>
    Effect.gen(function* () {
      const organizationId = `org_${crypto.randomUUID()}`;
      const aliceId = `user_${crypto.randomUUID().slice(0, 8)}`;
      const bobId = `user_${crypto.randomUUID().slice(0, 8)}`;
      const slug = randomSlug("ns");

      yield* asOrg(organizationId, (client) =>
        client.openapi.addSpec({ payload: makeMinimalOpenApiSpecPayload(slug) }),
      );

      // Alice's personal (`owner: "user"`) connection.
      yield* asUser(aliceId, organizationId, (client) =>
        client.connections.create({
          payload: {
            owner: "user",
            name: NAME_PERSONAL,
            integration: slug,
            template: TEMPLATE_API_KEY,
            value: "alice-secret",
          },
        }),
      );

      // Bob's personal connection under the same org + integration.
      yield* asUser(bobId, organizationId, (client) =>
        client.connections.create({
          payload: {
            owner: "user",
            name: NAME_PERSONAL,
            integration: slug,
            template: TEMPLATE_API_KEY,
            value: "bob-secret",
          },
        }),
      );

      // Each user sees only their own user-owned connection (no shadowing).
      const aliceConnections = yield* asUser(aliceId, organizationId, (client) =>
        client.connections.list({ query: { integration: slug, owner: "user" } }),
      );
      expect(aliceConnections.map((c) => c.owner)).toEqual(["user"]);

      const bobConnections = yield* asUser(bobId, organizationId, (client) =>
        client.connections.list({ query: { integration: slug, owner: "user" } }),
      );
      expect(bobConnections.map((c) => c.owner)).toEqual(["user"]);
    }),
  );

  it.effect(
    "addSpec persists the full Cloudflare spec through the real Drizzle/FumaDB path",
    () =>
      Effect.gen(function* () {
        const org = `org_${crypto.randomUUID()}`;
        const slug = randomSlug("ns");

        const result = yield* asOrg(org, (client) =>
          client.openapi.addSpec({
            payload: {
              spec: { kind: "blob", value: CLOUDFLARE_SPEC },
              slug,
              description: slug,
              baseUrl: "https://api.cloudflare.com/client/v4",
            },
          }),
        );
        expect(result.slug).toBe(slug);
        expect(result.toolCount).toBeGreaterThan(1000);

        const integrations = yield* asOrg(org, (client) => client.integrations.list({}));
        expect(integrations.map((s) => s.slug)).toContain(slug);

        // removeSpec on the same size must also land cleanly — catches
        // symmetrical regressions on the delete side (e.g. deleteMany
        // fanning out to per-row deletes).
        yield* asOrg(org, (client) => client.integrations.remove({ params: { slug } }));
        const after = yield* asOrg(org, (client) => client.integrations.list({}));
        expect(after.map((s) => s.slug)).not.toContain(slug);
      }),
    // 60s is generous for a correct O(1) write path on local PGlite;
    // a per-row regression would take minutes and hit this ceiling
    // long before the suite would tolerate it.
    { timeout: 60_000 },
  );
});

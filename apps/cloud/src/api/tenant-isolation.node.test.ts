// Tenant isolation integration test (v2). Runs in plain node (not workerd)
// via vitest.node.config.ts — workerd's dev-mode compile stack crashes
// on the full cloud module graph.
//
// In v2 the per-request executor binds `{ tenant: organizationId, subject:
// accountId }` from auth; there is no scopeId path param, so a request can no
// longer even name a foreign org. The invariant under test is therefore the
// tenant partition itself: integrations, connections, and tools written under
// one org's executor are invisible to another org's executor.

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

import { AuthTemplateSlug, ConnectionName, IntegrationSlug } from "@executor-js/sdk";
import { makeOpenApiHttpApiTestAddSpecPayload } from "@executor-js/plugin-openapi/testing";

import { asOrg } from "../testing/api-harness";

const PingGroup = HttpApiGroup.make("default", { topLevel: true }).add(
  HttpApiEndpoint.get("ping", "/ping", { success: Schema.Unknown }),
);

const TenantIsolationApi = HttpApi.make("tenantIsolationTest")
  .add(PingGroup)
  .annotateMerge(OpenApi.annotations({ title: "Tenant Test API", version: "1.0.0" }));

const makeTenantOpenApiSpecPayload = (
  slug: string,
  options: Omit<Parameters<typeof makeOpenApiHttpApiTestAddSpecPayload>[1], "slug"> = {},
) =>
  makeOpenApiHttpApiTestAddSpecPayload(TenantIsolationApi, {
    slug,
    baseUrl: "http://example.com",
    ...options,
  });

const randomSlug = () => IntegrationSlug.make(`a_${crypto.randomUUID().replace(/-/g, "_")}`);
const NAME_MAIN = ConnectionName.make("main");
const TEMPLATE_API_KEY = AuthTemplateSlug.make("apiKey");

describe("tenant isolation (HTTP)", () => {
  it.effect("integrations.list is scoped to the caller org", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const slugA = randomSlug();

      yield* asOrg(orgA, (client) =>
        client.openapi.addSpec({ payload: makeTenantOpenApiSpecPayload(slugA) }),
      );

      const orgBIntegrations = yield* asOrg(orgB, (client) => client.integrations.list({}));
      expect(orgBIntegrations.map((s) => s.slug)).not.toContain(slugA);
    }),
  );

  it.effect("tools.list is scoped to the caller org", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const slugA = randomSlug();

      yield* asOrg(orgA, (client) =>
        Effect.gen(function* () {
          yield* client.openapi.addSpec({ payload: makeTenantOpenApiSpecPayload(slugA) });
          yield* client.connections.create({
            payload: {
              owner: "org",
              name: NAME_MAIN,
              integration: slugA,
              template: TEMPLATE_API_KEY,
              value: "v",
            },
          });
        }),
      );

      const orgBTools = yield* asOrg(orgB, (client) => client.tools.list({ query: {} }));
      for (const address of orgBTools.map((t) => t.address)) {
        expect(address).not.toContain(slugA);
      }
    }),
  );

  it.effect("openapi.getIntegration cannot reach another org's integration", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const slugA = randomSlug();

      yield* asOrg(orgA, (client) =>
        client.openapi.addSpec({ payload: makeTenantOpenApiSpecPayload(slugA) }),
      );

      const integration = yield* asOrg(orgB, (client) =>
        client.openapi.getIntegration({ params: { slug: slugA } }),
      );

      expect(integration).toBeNull();
    }),
  );

  it.effect("connections.list is scoped to the caller org", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const slugA = randomSlug();
      const name = ConnectionName.make(`conn_a_${crypto.randomUUID().slice(0, 8)}`);

      yield* asOrg(orgA, (client) =>
        Effect.gen(function* () {
          yield* client.openapi.addSpec({ payload: makeTenantOpenApiSpecPayload(slugA) });
          yield* client.connections.create({
            payload: {
              owner: "org",
              name,
              integration: slugA,
              template: TEMPLATE_API_KEY,
              value: "super-secret-a",
            },
          });
        }),
      );

      const orgBConnections = yield* asOrg(orgB, (client) =>
        client.connections.list({ query: {} }),
      );
      expect(orgBConnections.map((c) => c.name)).not.toContain(name);
    }),
  );

  it.effect("connection metadata and value are not visible across orgs", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const slugA = randomSlug();
      const name = ConnectionName.make(`conn_a_${crypto.randomUUID().slice(0, 8)}`);

      yield* asOrg(orgA, (client) =>
        Effect.gen(function* () {
          yield* client.openapi.addSpec({ payload: makeTenantOpenApiSpecPayload(slugA) });
          yield* client.connections.create({
            payload: {
              owner: "org",
              name,
              integration: slugA,
              template: TEMPLATE_API_KEY,
              value: "super-secret-a",
            },
          });
        }),
      );

      const list = yield* asOrg(orgB, (client) => client.connections.list({ query: {} }));
      expect(list.map((c) => c.name)).not.toContain(name);
      expect(JSON.stringify(list)).not.toContain("super-secret-a");
    }),
  );

  it.effect("same-slug integration in two orgs are independent rows", () =>
    Effect.gen(function* () {
      const orgA = `org_${crypto.randomUUID()}`;
      const orgB = `org_${crypto.randomUUID()}`;
      const slug = IntegrationSlug.make(`shared_${crypto.randomUUID().replace(/-/g, "_")}`);

      yield* asOrg(orgA, (client) =>
        client.openapi.addSpec({
          payload: { ...makeTenantOpenApiSpecPayload(slug), description: "Org A API" },
        }),
      );
      yield* asOrg(orgB, (client) =>
        client.openapi.addSpec({
          payload: { ...makeTenantOpenApiSpecPayload(slug), description: "Org B API" },
        }),
      );

      // Updating org A's row must not mutate org B's same-slug row.
      yield* asOrg(orgA, (client) =>
        client.integrations.update({
          params: { slug },
          payload: { description: "Org A Updated API" },
        }),
      );

      const orgAIntegration = yield* asOrg(orgA, (client) =>
        client.integrations.get({ params: { slug } }),
      );
      const orgBIntegration = yield* asOrg(orgB, (client) =>
        client.integrations.get({ params: { slug } }),
      );
      expect(orgAIntegration?.description).toBe("Org A Updated API");
      expect(orgBIntegration?.description).toBe("Org B API");
    }),
  );
});

// Cross-target: registering an OpenAPI spec turns its operations into tools —
// the core "bring your own API" promise. Entirely through the typed client:
// the openapi plugin group (addSpec) composed onto the core API, then a
// connection via a `from` provider reference (no vault round-trip, so it works
// against the cloud stub), then the operation shows up in the tool catalog.
//
// Registration never calls the spec's server, so none is started here —
// actually invoking the tool against a live server is the follow-up scenario.
import { randomBytes, randomUUID } from "node:crypto";

import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";
import { openApiHttpPlugin } from "@executor-js/plugin-openapi/api";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
} from "@executor-js/sdk/shared";

import { scenario } from "../src/scenario";

const api = composePluginApi([openApiHttpPlugin()] as const);

/** OpenAPI 3 spec with a single GET /greet operation. */
const greetSpec = (baseUrl: string): string =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Greet API", version: "1.0.0" },
    servers: [{ url: baseUrl }],
    paths: {
      "/greet": {
        get: {
          operationId: "getGreeting",
          summary: "Return a greeting message",
          responses: { "200": { description: "A greeting" } },
        },
      },
    },
  });

scenario(
  "OpenAPI · registering a spec exposes its operations as tools",
  { needs: ["api"] },
  (ctx) =>
    Effect.gen(function* () {
      ctx.rec.say(
        "Register an inline OpenAPI 3 spec, connect it, and confirm its operation appears in the tool catalog.",
      );

      const identity = yield* ctx.target.newIdentity();
      const client = yield* ctx.api.client(api, identity);

      // Unique slug per run: selfhost shares the bootstrap-admin identity, so
      // the prefix keeps parallel/repeated runs out of each other's catalogs.
      const slug = `openapi-scn-greet-${randomBytes(4).toString("hex")}`;
      const specBaseUrl = "http://127.0.0.1:59999"; // never contacted during registration

      const added = yield* ctx.api.call(
        "openapi.addSpec",
        { slug, spec: "inline blob (GET /greet → getGreeting)" },
        client.openapi.addSpec({
          payload: {
            spec: { kind: "blob", value: greetSpec(specBaseUrl) },
            slug,
            baseUrl: specBaseUrl,
            authenticationTemplate: [
              {
                slug: "apiKey",
                type: "apiKey",
                headers: { "x-api-key": [{ type: "variable", name: "token" }] },
              },
            ],
          },
        }),
      );
      ctx.rec
        .expect(added.toolCount, "the spec's operations were extracted as tools")
        .toBeGreaterThan(0);
      ctx.rec.expect(added.slug, "the integration keeps the requested slug").toBe(slug);

      ctx.rec.say(
        "Connect the integration via a provider reference — the catalog stamps tools once a connection exists.",
      );
      const providers = yield* ctx.api.call("providers.list", {}, client.providers.list());
      ctx.rec
        .expect(providers.length, "a credential provider is available to connect with")
        .toBeGreaterThan(0);

      yield* ctx.api.call(
        "connections.create",
        { owner: "org", integration: slug, name: "main", template: "apiKey" },
        client.connections.create({
          payload: {
            owner: "org",
            name: ConnectionName.make("main"),
            integration: IntegrationSlug.make(slug),
            template: AuthTemplateSlug.make("apiKey"),
            from: { provider: providers[0]!, id: ProviderItemId.make(randomUUID()) },
          },
        }),
      );

      const tools = yield* ctx.api.call("tools.list", {}, client.tools.list());
      const mine = tools
        .filter((tool) => String(tool.integration) === slug)
        .map((tool) => tool.name);
      ctx.rec
        .expect(mine.join(", ") || "(none)", "the spec's operation is in the tool catalog")
        .toContain("getGreeting");
    }),
);

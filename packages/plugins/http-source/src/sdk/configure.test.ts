// ---------------------------------------------------------------------------
// http-source plugin — `configure` (add custom auth method) coverage. Mirrors
// the openapi plugin's configure tests against the http-source extension.
//
//   - round-trip: register an integration → `configure` adds a custom apiKey
//     method → `getConfig` shows it with the correct header placement +
//     `variable("token")` slot,
//   - slug generation for a method submitted without a slug,
//   - slug uniqueness/dedupe (matching slug replaces in place; two slugless get
//     distinct generated slugs),
//   - the merged template renders against a connection value at invoke time.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  createExecutor,
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ToolAddress,
} from "@executor-js/sdk";
import { makeTestConfig, memoryCredentialsPlugin } from "@executor-js/sdk/testing";

import { httpSourcePlugin } from "./plugin";
import { variable, type APIKeyAuthentication, type Authentication } from "./types";

const HTTP_SLUG = "http-source" as const;

const capturingLayer = (
  capture: { request?: HttpClientRequest.HttpClientRequest },
  response: Response,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      capture.request = request;
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    }),
  );

const testConfig = (httpClientLayer?: Layer.Layer<HttpClient.HttpClient>) => {
  const base = makeTestConfig({
    plugins: [httpSourcePlugin(), memoryCredentialsPlugin()] as const,
  });
  // `httpClientLayer` lives on the executor config (not a `makeTestConfig`
  // option) — the http-source plugin reads `ctx.httpClientLayer` at invoke time.
  return httpClientLayer ? { ...base, httpClientLayer } : base;
};

// A custom apiKey method placing the connection value into `x-api-key`.
const customApiKey: APIKeyAuthentication = {
  slug: AuthTemplateSlug.make("my_custom"),
  type: "apiKey",
  headers: { "x-api-key": [variable("token")] },
};

// Build an apiKey method WITHOUT a slug — simulating an untyped JSON caller that
// omits it, which `configure` should backfill with a generated `custom_<id>`.
// The cast is confined to this one boundary helper.
const sluglessApiKey = (placement: Omit<APIKeyAuthentication, "slug" | "type">): Authentication =>
  // lint-allow-double-cast: fixture — simulates a JSON caller omitting `slug`; configure backfills it
  ({ type: "apiKey", ...placement }) as unknown as Authentication;

// Register an http-source integration directly through the plugin extension.
interface HttpRegistrar {
  readonly register: (input: {
    readonly slug: IntegrationSlug;
    readonly description: string;
    readonly config: {
      readonly baseUrl: string;
      readonly authenticationTemplate: readonly Authentication[];
    };
  }) => Effect.Effect<void, unknown>;
}

const registerHttp = (
  ext: HttpRegistrar,
  slug: string,
  authenticationTemplate: readonly Authentication[] = [],
) =>
  ext.register({
    slug: IntegrationSlug.make(slug),
    description: slug,
    config: { baseUrl: "https://api.example.com", authenticationTemplate },
  });

describe("httpSourcePlugin — configure (custom auth method)", () => {
  it.effect("adds a custom apiKey method and getConfig reflects it", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(testConfig());

      yield* registerHttp(executor[HTTP_SLUG], "cfg_api");

      const merged = yield* executor[HTTP_SLUG].configure("cfg_api", {
        authenticationTemplate: [customApiKey],
      });

      expect(merged).toHaveLength(1);
      expect(String(merged[0]!.slug)).toBe("my_custom");

      const config = yield* executor[HTTP_SLUG].getConfig("cfg_api");
      const template = config?.authenticationTemplate ?? [];
      expect(template).toHaveLength(1);
      const entry = template[0] as APIKeyAuthentication;
      expect(entry.type).toBe("apiKey");
      expect(String(entry.slug)).toBe("my_custom");
      expect(entry.headers).toEqual({ "x-api-key": [variable("token")] });
    }),
  );

  it.effect("appends without dropping existing template entries", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(testConfig());

      const seed: Authentication = {
        slug: AuthTemplateSlug.make("seed"),
        type: "apiKey",
        headers: { authorization: ["Bearer ", variable("token")] },
      };

      yield* registerHttp(executor[HTTP_SLUG], "cfg_append", [seed]);

      const merged = yield* executor[HTTP_SLUG].configure("cfg_append", {
        authenticationTemplate: [customApiKey],
      });

      expect(merged.map((m: Authentication) => String(m.slug))).toEqual(["seed", "my_custom"]);
    }),
  );

  it.effect("generates a custom_<id> slug for a method submitted without one", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(testConfig());

      yield* registerHttp(executor[HTTP_SLUG], "cfg_genslug");

      const slugless = sluglessApiKey({ headers: { "x-api-key": [variable("token")] } });

      const merged = yield* executor[HTTP_SLUG].configure("cfg_genslug", {
        authenticationTemplate: [slugless],
      });

      expect(merged).toHaveLength(1);
      expect(String(merged[0]!.slug)).toMatch(/^custom_[a-z0-9]+$/);
    }),
  );

  it.effect("dedupes: a matching slug replaces in place; two slugless get distinct slugs", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(testConfig());

      yield* registerHttp(executor[HTTP_SLUG], "cfg_dedupe", [customApiKey]);

      const replacement: APIKeyAuthentication = {
        slug: AuthTemplateSlug.make("my_custom"),
        type: "apiKey",
        headers: { "x-other": [variable("token")] },
      };
      const slugless = sluglessApiKey({ queryParams: { api_key: [variable("token")] } });
      const slugless2 = sluglessApiKey({ queryParams: { token: [variable("token")] } });

      const merged = yield* executor[HTTP_SLUG].configure("cfg_dedupe", {
        authenticationTemplate: [replacement, slugless, slugless2],
      });

      const slugs = merged.map((m: Authentication) => String(m.slug));
      expect(slugs.filter((s: string) => s === "my_custom")).toHaveLength(1);
      expect(merged).toHaveLength(3);
      const generated = slugs.filter((s: string) => s.startsWith("custom_"));
      expect(generated).toHaveLength(2);
      expect(new Set(generated).size).toBe(2);
      const replaced = merged.find(
        (m: Authentication) => String(m.slug) === "my_custom",
      ) as APIKeyAuthentication;
      expect(replaced.headers).toEqual({ "x-other": [variable("token")] });
    }),
  );

  it.effect("a configured custom method renders against a connection value at invoke time", () =>
    Effect.gen(function* () {
      const capture: { request?: HttpClientRequest.HttpClientRequest } = {};
      const layer = capturingLayer(
        capture,
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      const executor = yield* createExecutor(testConfig(layer));

      yield* registerHttp(executor[HTTP_SLUG], "cfg_invoke");

      yield* executor[HTTP_SLUG].configure("cfg_invoke", {
        authenticationTemplate: [customApiKey],
      });

      yield* executor.connections.create({
        owner: "org",
        name: ConnectionName.make("main"),
        integration: IntegrationSlug.make("cfg_invoke"),
        template: AuthTemplateSlug.make("my_custom"),
        value: "configured-secret",
      });

      yield* executor.execute(ToolAddress.make("tools.cfg_invoke.org.main.request"), {
        method: "GET",
        path: "/ping",
      });

      expect(capture.request!.headers["x-api-key"]).toBe("configured-secret");
    }),
  );

  it.effect("getConfig returns null for an unknown integration", () =>
    Effect.gen(function* () {
      const executor = yield* createExecutor(testConfig());
      expect(yield* executor[HTTP_SLUG].getConfig("nope")).toBeNull();
    }),
  );
});

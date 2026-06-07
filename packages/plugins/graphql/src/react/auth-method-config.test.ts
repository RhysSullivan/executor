import { describe, expect, it } from "@effect/vitest";
import { AuthTemplateSlug } from "@executor-js/sdk/shared";

import { authMethodsFromConfig, graphqlTemplatesFromPlacements } from "./auth-method-config";
import { GRAPHQL_APIKEY_TEMPLATE } from "./defaults";
import type { AuthTemplate } from "../sdk/types";

describe("graphqlTemplatesFromPlacements", () => {
  it("maps a single named header placement → one apiKey template (primary slug)", () => {
    const templates = graphqlTemplatesFromPlacements([
      { carrier: "header", name: "Authorization", prefix: "Bearer " },
    ]);
    expect(templates).toEqual([
      {
        kind: "apiKey",
        slug: GRAPHQL_APIKEY_TEMPLATE,
        in: "header",
        name: "Authorization",
        prefix: "Bearer ",
      },
    ]);
  });

  it("emits one template per named placement; only the first keeps the slug", () => {
    const templates = graphqlTemplatesFromPlacements(
      [
        { carrier: "header", name: "Authorization", prefix: "" },
        { carrier: "query", name: "api_key", prefix: "" },
      ],
      "",
    );
    expect(templates).toEqual([
      { kind: "apiKey", slug: "", in: "header", name: "Authorization" },
      { kind: "apiKey", slug: "", in: "query", name: "api_key" },
    ]);
  });

  it("drops unnamed placements", () => {
    const templates = graphqlTemplatesFromPlacements([
      { carrier: "header", name: "", prefix: "" },
      { carrier: "header", name: "X-Token", prefix: "" },
    ]);
    expect(templates).toEqual([
      { kind: "apiKey", slug: GRAPHQL_APIKEY_TEMPLATE, in: "header", name: "X-Token" },
    ]);
  });
});

describe("authMethodsFromConfig", () => {
  it("maps a header apiKey template → a generic apikey method with a placement", () => {
    const config: AuthTemplate[] = [
      { kind: "apiKey", slug: "apiKey", in: "header", name: "Authorization", prefix: "Bearer " },
    ];
    expect(authMethodsFromConfig(config)).toEqual([
      {
        id: "apiKey",
        label: "API key (Authorization)",
        kind: "apikey",
        source: "spec",
        template: AuthTemplateSlug.make("apiKey"),
        placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
      },
    ]);
  });

  it("marks a custom_ slug as a custom method", () => {
    const config: AuthTemplate[] = [
      { kind: "apiKey", slug: "custom_abc", in: "query", name: "token" },
    ];
    const [method] = authMethodsFromConfig(config);
    expect(method?.source).toBe("custom");
    expect(method?.placements).toEqual([{ carrier: "query", name: "token", prefix: "" }]);
  });

  it("maps an oauth2 template → an oauth method", () => {
    const config: AuthTemplate[] = [{ kind: "oauth2", slug: "oauth2" }];
    expect(authMethodsFromConfig(config)).toEqual([
      {
        id: "oauth2",
        label: "OAuth2",
        kind: "oauth",
        source: "spec",
        template: AuthTemplateSlug.make("oauth2"),
        placements: [],
        oauth: {},
      },
    ]);
  });
});

describe("round-trip (placements → templates → methods)", () => {
  it("a header placement survives the round-trip into a generic method", () => {
    const placements = [{ carrier: "header" as const, name: "X-Api-Key", prefix: "" }];
    const templates = graphqlTemplatesFromPlacements(placements, "");
    const [method] = authMethodsFromConfig(templates);
    expect(method?.placements).toEqual(placements);
  });
});

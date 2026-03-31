import {
  describe,
  expect,
  it,
} from "@effect/vitest";

import {
  resolveSourceIconUrl,
} from "./source-icon";

describe("resolveSourceIconUrl", () => {
  it("prefers the configured override", () => {
    expect(resolveSourceIconUrl({
      configuredIconUrl: "https://cdn.example.com/icon.png",
      kind: "mcp",
      config: {
        endpoint: "https://mcp.axiom.co/mcp",
      },
    })).toBe("https://cdn.example.com/icon.png");
  });

  it("derives remote MCP icons from the endpoint host", () => {
    expect(resolveSourceIconUrl({
      kind: "mcp",
      config: {
        endpoint: "https://mcp.axiom.co/mcp",
      },
    })).toBe("https://www.google.com/s2/favicons?domain=axiom.co&sz=32");
  });

  it("derives GraphQL icons from the endpoint host", () => {
    expect(resolveSourceIconUrl({
      kind: "graphql",
      config: {
        endpoint: "https://api.linear.app/graphql",
      },
    })).toBe("https://www.google.com/s2/favicons?domain=linear.app&sz=32");
  });

  it("prefers OpenAPI baseUrl over specUrl", () => {
    expect(resolveSourceIconUrl({
      kind: "openapi",
      config: {
        specUrl: "https://raw.githubusercontent.com/acme/api/main/openapi.json",
        baseUrl: "https://api.acme.co/v1",
      },
    })).toBe("https://www.google.com/s2/favicons?domain=acme.co&sz=32");
  });

  it("falls back to OpenAPI specUrl when baseUrl is absent", () => {
    expect(resolveSourceIconUrl({
      kind: "openapi",
      config: {
        specUrl: "https://docs.stripe.com/openapi/spec",
        baseUrl: null,
      },
    })).toBe("https://www.google.com/s2/favicons?domain=stripe.com&sz=32");
  });

  it("skips raw OpenAPI spec hosts when no baseUrl is available", () => {
    expect(resolveSourceIconUrl({
      kind: "openapi",
      config: {
        specUrl: "https://raw.githubusercontent.com/acme/api/main/openapi.json",
        baseUrl: null,
      },
    })).toBe(null);
  });

  it("returns null for stdio MCP sources without an override", () => {
    expect(resolveSourceIconUrl({
      kind: "mcp",
      config: {
        endpoint: null,
        command: "npx",
      },
    })).toBe(null);
  });
});

import { describe, expect, it } from "@effect/vitest";

import {
  domainLabelFromUrl,
  integrationDisplayNameFromUrl,
  pascalCaseDomainLabel,
} from "./integration-identity";

describe("integration identity URL display names", () => {
  it("uses the apex domain label without the public suffix", () => {
    expect(domainLabelFromUrl("https://api.example.co.uk/graphql")).toBe("example");
  });

  it("normalizes domain labels to PascalCase", () => {
    expect(pascalCaseDomainLabel("my-api")).toBe("MyApi");
  });

  it("appends the integration kind to the PascalCase domain label", () => {
    expect(integrationDisplayNameFromUrl("https://mcp.linear.app/sse", "MCP")).toBe("Linear MCP");
    expect(integrationDisplayNameFromUrl("https://api.shopify.com/graphql", "GraphQL")).toBe(
      "Shopify GraphQL",
    );
  });
});

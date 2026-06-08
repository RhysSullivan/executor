import { describe, expect, it } from "@effect/vitest";

import {
  GRAPHQL_APIKEY_TEMPLATE,
  graphqlApiKeyAuthTemplate,
  graphqlConnectionName,
} from "./defaults";

describe("graphqlApiKeyAuthTemplate", () => {
  it("builds an apiKey header template using the template slug", () => {
    const template = graphqlApiKeyAuthTemplate("X-Api-Key");

    expect(template).toEqual({
      kind: "apiKey",
      slug: GRAPHQL_APIKEY_TEMPLATE,
      in: "header",
      name: "X-Api-Key",
    });
  });

  it("falls back to Authorization when no header name is given", () => {
    expect(graphqlApiKeyAuthTemplate("").name).toBe("Authorization");
  });
});

describe("graphqlConnectionName", () => {
  it("is deterministic per integration + owner", () => {
    expect(String(graphqlConnectionName("github_com", "user"))).toBe("githubComUser");
    expect(String(graphqlConnectionName("github_com", "org"))).toBe("githubComOrg");
  });
});

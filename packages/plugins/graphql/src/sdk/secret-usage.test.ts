import { describe, expect, it } from "vitest";

import type { StoredGraphqlSource } from "./store";
import { collectGraphqlSecretIds } from "./secret-usage";

describe("collectGraphqlSecretIds", () => {
  it("collects secret-backed header ids", () => {
    const source: StoredGraphqlSource = {
      namespace: "github",
      scope: "org_test",
      name: "GitHub GraphQL",
      endpoint: "https://api.github.com/graphql",
      headers: {
        Authorization: {
          secretId: "github_pat",
          prefix: "Bearer ",
        },
        "X-Static": "static",
      },
    };

    expect(collectGraphqlSecretIds(source)).toEqual(["github_pat"]);
  });
});

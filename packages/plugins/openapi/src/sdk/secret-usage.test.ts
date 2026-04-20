import { describe, expect, it } from "vitest";

import type { StoredSource } from "./store";
import { collectOpenApiSecretIds } from "./secret-usage";

describe("collectOpenApiSecretIds", () => {
  it("collects header and oauth2 secret ids", () => {
    const source: StoredSource = {
      namespace: "vercel",
      scope: "org_test",
      name: "Vercel API",
      config: {
        spec: "https://openapi.vercel.sh",
        headers: {
          Authorization: {
            secretId: "header_secret",
            prefix: "Bearer ",
          },
          "X-Static": "static",
        },
        oauth2: {
          kind: "oauth2",
          securitySchemeName: "oauth2",
          flow: "authorizationCode",
          tokenUrl: "https://example.com/token",
          clientIdSecretId: "client_id_secret",
          clientSecretSecretId: "client_secret_secret",
          accessTokenSecretId: "access_token_secret",
          refreshTokenSecretId: "refresh_token_secret",
          tokenType: "Bearer",
          expiresAt: null,
          scope: null,
          scopes: ["read"],
        },
      },
      invocationConfig: {
        baseUrl: "https://api.vercel.com",
        headers: {},
        oauth2: undefined as never,
      },
    };

    expect(collectOpenApiSecretIds(source)).toEqual([
      "header_secret",
      "client_id_secret",
      "client_secret_secret",
      "access_token_secret",
      "refresh_token_secret",
    ]);
  });
});

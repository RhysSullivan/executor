import { describe, expect, it } from "@effect/vitest";
import { throws } from "@effect/vitest/utils";
import * as Schema from "effect/Schema";

import {
  CreateExecutionPayloadSchema,
} from "./executions/api";
import { CreatePolicyPayloadSchema } from "./policies/api";
import {
  ConnectSourcePayloadSchema,
  CreateSourcePayloadSchema,
  UpdateSourcePayloadSchema,
} from "./sources/api";

describe("control-plane payload schemas", () => {
  it("normalizes trimmed strings at decode time", () => {
    expect(
      Schema.decodeUnknownSync(CreateSourcePayloadSchema)({
        name: "  Github  ",
        kind: "openapi",
        endpoint: "  https://api.github.com  ",
      }),
    ).toEqual({
      name: "Github",
      kind: "openapi",
      endpoint: "https://api.github.com",
    });

    expect(
      Schema.decodeUnknownSync(CreateExecutionPayloadSchema)({
        code: "  console.log('ok')  ",
      }),
    ).toEqual({
      code: "console.log('ok')",
    });

    expect(
      Schema.decodeUnknownSync(ConnectSourcePayloadSchema)({
        kind: "openapi",
        endpoint: "  https://api.github.com  ",
        specUrl: "  https://example.com/openapi.json  ",
        oauthClient: {
          clientId: "  github-client  ",
          clientSecret: "  github-secret  ",
        },
        oauth2Setup: {
          authorizationEndpoint: "  https://github.com/login/oauth/authorize  ",
          tokenEndpoint: "  https://github.com/login/oauth/access_token  ",
          scopes: [" repo ", " read:user "],
          headerName: "  Authorization  ",
          prefix: "  Bearer  ",
          clientAuthentication: "client_secret_post",
        },
      }),
    ).toEqual({
      kind: "openapi",
      endpoint: "https://api.github.com",
      specUrl: "https://example.com/openapi.json",
      oauthClient: {
        clientId: "github-client",
        clientSecret: "github-secret",
      },
      oauth2Setup: {
        authorizationEndpoint: "https://github.com/login/oauth/authorize",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        scopes: [" repo ", " read:user "],
        headerName: "  Authorization  ",
        prefix: "  Bearer  ",
        clientAuthentication: "client_secret_post",
      },
    });

    expect(
      Schema.decodeUnknownSync(ConnectSourcePayloadSchema)({
        kind: "google_discovery",
        service: "  sheets  ",
        version: "  v4  ",
        discoveryUrl: "  https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest  ",
        oauthClient: {
          clientId: "  google-client  ",
          clientSecret: "  google-secret  ",
        },
      }),
    ).toEqual({
      kind: "google_discovery",
      service: "sheets",
      version: "v4",
      discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
      oauthClient: {
        clientId: "google-client",
        clientSecret: "google-secret",
      },
    });

    expect(
      Schema.decodeUnknownSync(CreatePolicyPayloadSchema)({
        resourcePattern: "  source.github.*  ",
      }),
    ).toEqual({
        resourcePattern: "source.github.*",
    });
  });

  it("rejects blank strings for normalized string fields", () => {
    throws(() =>
      Schema.decodeUnknownSync(UpdateSourcePayloadSchema)({
        endpoint: "   ",
      })
    );

    throws(() =>
      Schema.decodeUnknownSync(ConnectSourcePayloadSchema)({
        kind: "graphql",
        endpoint: "   ",
      })
    );

    throws(() =>
      Schema.decodeUnknownSync(CreatePolicyPayloadSchema)({
        resourcePattern: "   ",
      })
    );
  });
});

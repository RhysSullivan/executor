import { describe, expect, it } from "@effect/vitest";
import { throws } from "@effect/vitest/utils";
import * as Schema from "effect/Schema";

import {
  CreateExecutionPayloadSchema,
} from "./executions/api";
import {
  CreateOrganizationPayloadSchema,
  UpdateOrganizationPayloadSchema,
} from "./organizations/api";
import { CreatePolicyPayloadSchema } from "./policies/api";
import {
  ConnectSourcePayloadSchema,
  CreateSourcePayloadSchema,
  UpdateSourcePayloadSchema,
} from "./sources/api";
import { CreateWorkspacePayloadSchema } from "./workspaces/api";

describe("control-plane payload schemas", () => {
  it("normalizes trimmed strings at decode time", () => {
    expect(
      Schema.decodeUnknownSync(CreateOrganizationPayloadSchema)({
        name: "  Acme  ",
        slug: "  acme  ",
      }),
    ).toEqual({
      name: "Acme",
      slug: "acme",
    });

    expect(
      Schema.decodeUnknownSync(CreateWorkspacePayloadSchema)({
        name: "  Primary  ",
      }),
    ).toEqual({
      name: "Primary",
    });

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
      }),
    ).toEqual({
        kind: "openapi",
        endpoint: "https://api.github.com",
        specUrl: "https://example.com/openapi.json",
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
      Schema.decodeUnknownSync(CreateOrganizationPayloadSchema)({
        name: "   ",
      })
    );

    throws(() =>
      Schema.decodeUnknownSync(UpdateOrganizationPayloadSchema)({
        name: "   ",
      })
    );

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
  });
});

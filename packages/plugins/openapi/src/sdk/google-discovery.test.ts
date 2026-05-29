import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { convertGoogleDiscoveryToOpenApi } from "./google-discovery";

const ConvertedOperation = Schema.Struct({
  operationId: Schema.String,
  "x-executor-toolPath": Schema.String,
  parameters: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      in: Schema.String,
      required: Schema.Boolean,
      style: Schema.optional(Schema.String),
      explode: Schema.optional(Schema.Boolean),
    }),
  ),
  security: Schema.optional(
    Schema.Array(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  ),
  "x-google-scopes": Schema.Array(Schema.String),
});

const ConvertedSpec = Schema.Struct({
  openapi: Schema.String,
  servers: Schema.Array(Schema.Struct({ url: Schema.String })),
  paths: Schema.Record(Schema.String, Schema.Record(Schema.String, ConvertedOperation)),
});

const decodeConvertedSpec = Schema.decodeUnknownSync(Schema.fromJsonString(ConvertedSpec));

it.effect("converts Google Discovery documents into Executor-preserving OpenAPI 3 specs", () =>
  Effect.gen(function* () {
    const result = yield* convertGoogleDiscoveryToOpenApi({
      discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest",
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      documentText: JSON.stringify({
        name: "gmail",
        version: "v1",
        title: "Gmail API",
        rootUrl: "https://gmail.googleapis.com/",
        servicePath: "",
        auth: {
          oauth2: {
            scopes: {
              "https://www.googleapis.com/auth/gmail.metadata": {
                description: "Read metadata",
              },
            },
          },
        },
        resources: {
          users: {
            resources: {
              messages: {
                methods: {
                  list: {
                    id: "gmail.users.messages.list",
                    httpMethod: "GET",
                    path: "gmail/v1/users/{userId}/messages",
                    scopes: ["https://www.googleapis.com/auth/gmail.metadata"],
                    parameters: {
                      userId: {
                        location: "path",
                        required: true,
                        type: "string",
                      },
                      metadataHeaders: {
                        location: "query",
                        repeated: true,
                        type: "string",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    });

    const spec = decodeConvertedSpec(result.specText);
    const operation = spec.paths["/gmail/v1/users/{userId}/messages"]?.get;
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers).toEqual([{ url: "https://gmail.googleapis.com/" }]);
    expect(operation).toMatchObject({
      operationId: "users.messages.list",
      "x-executor-toolPath": "users.messages.list",
      "x-google-scopes": ["https://www.googleapis.com/auth/gmail.metadata"],
    });
    expect(operation?.security).toEqual([
      { googleOAuth2: ["https://www.googleapis.com/auth/gmail.metadata"] },
    ]);
    expect(operation?.parameters).toContainEqual(
      expect.objectContaining({
        name: "metadataHeaders",
        in: "query",
        style: "form",
        explode: true,
      }),
    );
  }),
);

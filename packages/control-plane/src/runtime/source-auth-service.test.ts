import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  McpSourceAuthSessionDataJsonSchema,
  type Source,
} from "#schema";

import {
  createTerminalSourceAuthSessionPatch,
} from "./source-auth-service";

const makeExistingOpenApiSource = (auth: Source["auth"]): Source => ({
  id: "src_test" as Source["id"],
  workspaceId: "ws_test" as Source["workspaceId"],
  name: "GitHub",
  kind: "openapi",
  endpoint: "https://api.github.com",
  status: "connected",
  enabled: true,
  namespace: "github",
  bindingVersion: 1,
  binding: {
    specUrl: "https://example.com/openapi.json",
    defaultHeaders: null,
  },
  importAuthPolicy: "reuse_runtime",
  importAuth: { kind: "none" },
  auth,
  sourceHash: null,
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
});

describe("source-auth-service", () => {
  const encodeSessionDataJson = Schema.encodeSync(McpSourceAuthSessionDataJsonSchema);

  const baseSessionDataJson = encodeSessionDataJson({
    kind: "mcp_oauth",
    endpoint: "https://example.com/resource",
    redirectUri: "http://127.0.0.1/callback",
    scope: null,
    resourceMetadataUrl: "https://example.com/resource",
    authorizationServerUrl: "https://example.com/as",
    resourceMetadata: {
      issuer: "https://example.com",
    },
    authorizationServerMetadata: {
      token_endpoint: "https://example.com/token",
    },
    clientInformation: {
      client_id: "abc",
    },
    codeVerifier: "verifier",
    authorizationUrl: "https://example.com/auth",
  });

  it("clears ephemeral OAuth session fields when failing a session", () => {
    const patch = createTerminalSourceAuthSessionPatch({
      sessionDataJson: baseSessionDataJson,
      status: "failed",
      now: 123,
      errorText: "OAuth authorization failed",
    });

    expect(patch).toMatchObject({
      sessionDataJson: baseSessionDataJson,
      status: "failed",
      errorText: "OAuth authorization failed",
      completedAt: 123,
      updatedAt: 123,
    });
  });

  it("clears ephemeral OAuth session fields when completing a session", () => {
    const patch = createTerminalSourceAuthSessionPatch({
      sessionDataJson: baseSessionDataJson,
      status: "completed",
      now: 456,
      errorText: null,
    });

    expect(patch).toMatchObject({
      sessionDataJson: baseSessionDataJson,
      status: "completed",
      errorText: null,
      completedAt: 456,
      updatedAt: 456,
    });
  });
});

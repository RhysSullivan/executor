import { describe, expect, it } from "@effect/vitest";

import type {
  ConfigHeaderValue,
  McpAuthConfig,
  McpConnectionAuth,
} from "./schema";
import { SECRET_REF_PREFIX } from "./schema";
import {
  headerFromConfigValue,
  headerToConfigValue,
  headersFromConfigValues,
  headersToConfigValues,
  mcpAuthFromConfig,
  mcpAuthToConfig,
  type PluginHeaderValue,
} from "./transform";

// ---------------------------------------------------------------------------
// Each fixture covers every branch of the corresponding union so a new
// discriminant without paired updates fails the roundtrip at test time,
// not at a user's boot time.
// ---------------------------------------------------------------------------

const runtimeAuths: readonly McpConnectionAuth[] = [
  { kind: "none" },
  {
    kind: "header",
    headerName: "Authorization",
    secretId: "posthog-api-key",
    prefix: "Bearer ",
  },
  {
    kind: "header",
    headerName: "X-Api-Key",
    secretId: "plain-key",
  },
  { kind: "oauth2", connectionId: "mcp-oauth2-linear" },
];

const fileAuths: readonly McpAuthConfig[] = [
  { kind: "none" },
  {
    kind: "header",
    headerName: "Authorization",
    secret: `${SECRET_REF_PREFIX}posthog-api-key`,
    prefix: "Bearer ",
  },
  {
    kind: "header",
    headerName: "X-Api-Key",
    secret: `${SECRET_REF_PREFIX}plain-key`,
  },
  { kind: "oauth2", connectionId: "mcp-oauth2-linear" },
];

const runtimeHeaders: readonly PluginHeaderValue[] = [
  "static-value",
  { secretId: "axiom-api-key" },
  { secretId: "axiom-api-key", prefix: "Bearer " },
];

const fileHeaders: readonly ConfigHeaderValue[] = [
  "static-value",
  `${SECRET_REF_PREFIX}axiom-api-key`,
  { value: `${SECRET_REF_PREFIX}axiom-api-key`, prefix: "Bearer " },
];

describe("mcp auth transform", () => {
  it("mcpAuthToConfig ∘ mcpAuthFromConfig is identity on file shapes", () => {
    for (const file of fileAuths) {
      expect(mcpAuthToConfig(mcpAuthFromConfig(file))).toEqual(file);
    }
  });

  it("mcpAuthFromConfig ∘ mcpAuthToConfig is identity on runtime shapes", () => {
    for (const runtime of runtimeAuths) {
      expect(mcpAuthFromConfig(mcpAuthToConfig(runtime))).toEqual(runtime);
    }
  });

  it("strips secret-public-ref prefix on header inbound", () => {
    expect(
      mcpAuthFromConfig({
        kind: "header",
        headerName: "Authorization",
        secret: `${SECRET_REF_PREFIX}posthog-api-key`,
        prefix: "Bearer ",
      }),
    ).toEqual({
      kind: "header",
      headerName: "Authorization",
      secretId: "posthog-api-key",
      prefix: "Bearer ",
    });
  });

  it("adds secret-public-ref prefix on header outbound", () => {
    expect(
      mcpAuthToConfig({
        kind: "header",
        headerName: "Authorization",
        secretId: "posthog-api-key",
      }),
    ).toEqual({
      kind: "header",
      headerName: "Authorization",
      secret: `${SECRET_REF_PREFIX}posthog-api-key`,
      prefix: undefined,
    });
  });

  it("preserves oauth2 connectionId without transformation", () => {
    const runtime: McpConnectionAuth = {
      kind: "oauth2",
      connectionId: "mcp-oauth2-posthog",
    };
    expect(mcpAuthToConfig(runtime)).toEqual(runtime);
    expect(mcpAuthFromConfig(mcpAuthToConfig(runtime)!)).toEqual(runtime);
  });

  it("treats undefined as undefined on both sides", () => {
    expect(mcpAuthToConfig(undefined)).toBeUndefined();
    expect(mcpAuthFromConfig(undefined)).toBeUndefined();
  });
});

describe("header transform", () => {
  it("headerToConfigValue ∘ headerFromConfigValue is identity on file shapes", () => {
    for (const file of fileHeaders) {
      expect(headerToConfigValue(headerFromConfigValue(file))).toEqual(file);
    }
  });

  it("headerFromConfigValue ∘ headerToConfigValue is identity on runtime shapes", () => {
    for (const runtime of runtimeHeaders) {
      expect(headerFromConfigValue(headerToConfigValue(runtime))).toEqual(runtime);
    }
  });

  it("strips prefix from bare string secret ref", () => {
    expect(headerFromConfigValue(`${SECRET_REF_PREFIX}my-key`)).toEqual({
      secretId: "my-key",
    });
  });

  it("preserves literal string headers", () => {
    expect(headerFromConfigValue("literal")).toBe("literal");
    expect(headerToConfigValue("literal")).toBe("literal");
  });

  it("headersToConfigValues / headersFromConfigValues roundtrip a record", () => {
    const file: Record<string, ConfigHeaderValue> = {
      Authorization: { value: `${SECRET_REF_PREFIX}api-key`, prefix: "Bearer " },
      "X-Static": "literal",
      "X-Bare-Ref": `${SECRET_REF_PREFIX}bare`,
    };
    const runtime = headersFromConfigValues(file)!;
    expect(runtime).toEqual({
      Authorization: { secretId: "api-key", prefix: "Bearer " },
      "X-Static": "literal",
      "X-Bare-Ref": { secretId: "bare" },
    });
    expect(headersToConfigValues(runtime)).toEqual(file);
  });

  it("treats undefined records as undefined", () => {
    expect(headersToConfigValues(undefined)).toBeUndefined();
    expect(headersFromConfigValues(undefined)).toBeUndefined();
  });
});

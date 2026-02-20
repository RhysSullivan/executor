import { expect, test } from "bun:test";
import { normalizeExternalToolSource } from "../runtime/tool_source_loading";
import { normalizeToolSourceConfig } from "./tool_source_config";

test("normalizeToolSourceConfig returns an error result for invalid mcp config", () => {
  const result = normalizeToolSourceConfig("mcp", {});

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toBe("Tool source url is required");
  }
});

test("normalizeToolSourceConfig trims and normalizes openapi auth/header values", () => {
  const result = normalizeToolSourceConfig("openapi", {
    spec: " https://example.com/openapi.json ",
    baseUrl: " https://api.example.com ",
    auth: {
      type: "apiKey",
      header: " x-api-key ",
    },
  });

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.spec).toBe("https://example.com/openapi.json");
    expect(result.value.baseUrl).toBe("https://api.example.com");
    expect(result.value.auth?.type).toBe("apiKey");
    if (result.value.auth?.type === "apiKey") {
      expect(result.value.auth.header).toBe("x-api-key");
    }
  }
});

test("normalizeExternalToolSource returns error result with source context", () => {
  const result = normalizeExternalToolSource({
    id: "src_123",
    type: "graphql",
    name: "bad-graphql",
    config: {},
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toBe(
      "Failed to normalize 'bad-graphql' source config: Tool source endpoint is required",
    );
  }
});

test("normalizeToolSourceConfig validates string maps with field-level errors", () => {
  const result = normalizeToolSourceConfig("mcp", {
    url: "https://example.com/mcp",
    queryParams: {
      token: 123,
    },
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toBe("Tool source queryParams.token must be a string");
  }
});

test("normalizeToolSourceConfig validates auth mode for apiKey auth", () => {
  const result = normalizeToolSourceConfig("openapi", {
    spec: "https://example.com/openapi.json",
    auth: {
      type: "apiKey",
      mode: "invalid",
      header: "x-api-key",
    },
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toBe("Tool source auth.mode must be 'account', 'workspace', or 'organization'");
  }
});

test("normalizeToolSourceConfig rejects inline static auth secrets", () => {
  const result = normalizeToolSourceConfig("openapi", {
    spec: "https://example.com/openapi.json",
    auth: {
      type: "bearer",
      mode: "workspace",
      token: "secret-token",
    },
  });

  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.message).toBe("Tool source auth.mode must be 'account', 'workspace', or 'organization'");
  }
});

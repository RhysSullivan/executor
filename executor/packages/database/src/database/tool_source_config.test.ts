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
      value: "token-value",
    },
  });

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.spec).toBe("https://example.com/openapi.json");
    expect(result.value.baseUrl).toBe("https://api.example.com");
    expect(result.value.auth?.type).toBe("apiKey");
    if (result.value.auth?.type === "apiKey") {
      expect(result.value.auth.header).toBe("x-api-key");
      expect(result.value.auth.value).toBe("token-value");
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

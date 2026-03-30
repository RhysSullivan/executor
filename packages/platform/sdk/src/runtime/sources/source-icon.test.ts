import {
  describe,
  expect,
  it,
} from "@effect/vitest";

import {
  resolveSourceIconUrl,
} from "./source-icon";

describe("resolveSourceIconUrl", () => {
  it("prefers the configured override", () => {
    expect(resolveSourceIconUrl({
      configuredIconUrl: "https://cdn.example.com/icon.png",
      kind: "mcp",
      config: {
        endpoint: "https://mcp.axiom.co/mcp",
      },
    })).toBe("https://cdn.example.com/icon.png");
  });

  it("derives remote MCP icons from the endpoint host", () => {
    expect(resolveSourceIconUrl({
      kind: "mcp",
      config: {
        endpoint: "https://mcp.axiom.co/mcp",
      },
    })).toBe("https://www.google.com/s2/favicons?domain=axiom.co&sz=32");
  });

  it("returns null for stdio MCP sources without an override", () => {
    expect(resolveSourceIconUrl({
      kind: "mcp",
      config: {
        endpoint: null,
        command: "npx",
      },
    })).toBe(null);
  });
});

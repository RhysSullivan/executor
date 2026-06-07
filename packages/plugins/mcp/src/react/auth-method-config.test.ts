import { describe, expect, it } from "@effect/vitest";
import type { AuthTemplateEditorValue } from "@executor-js/react/components/auth-template-editor";

import { mcpAuthTemplateFromEditorValue } from "./auth-method-config";

describe("mcpAuthTemplateFromEditorValue", () => {
  it("maps 'none' → { kind: 'none' }", () => {
    expect(mcpAuthTemplateFromEditorValue({ kind: "none" })).toEqual({ kind: "none" });
  });

  it("maps 'oauth' → { kind: 'oauth2' } (endpoints are resolved at connect time)", () => {
    const value: AuthTemplateEditorValue = {
      kind: "oauth",
      authorizationUrl: "https://a.example.com/auth",
      tokenUrl: "https://a.example.com/token",
      scopes: ["mcp.read"],
    };
    expect(mcpAuthTemplateFromEditorValue(value)).toEqual({ kind: "oauth2" });
  });

  it("maps apiKey → a header template from the first named header placement (with prefix)", () => {
    const value: AuthTemplateEditorValue = {
      kind: "apikey",
      placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
    };
    expect(mcpAuthTemplateFromEditorValue(value)).toEqual({
      kind: "header",
      headerName: "Authorization",
      prefix: "Bearer ",
    });
  });

  it("omits the prefix when blank", () => {
    const value: AuthTemplateEditorValue = {
      kind: "apikey",
      placements: [{ carrier: "header", name: "X-Token", prefix: "" }],
    };
    expect(mcpAuthTemplateFromEditorValue(value)).toEqual({
      kind: "header",
      headerName: "X-Token",
    });
  });

  it("skips a query placement (MCP carries a single header) and falls back to none", () => {
    const value: AuthTemplateEditorValue = {
      kind: "apikey",
      placements: [{ carrier: "query", name: "api_key", prefix: "" }],
    };
    expect(mcpAuthTemplateFromEditorValue(value)).toEqual({ kind: "none" });
  });

  it("uses the first NAMED header placement (skips unnamed)", () => {
    const value: AuthTemplateEditorValue = {
      kind: "apikey",
      placements: [
        { carrier: "header", name: "", prefix: "" },
        { carrier: "header", name: "X-Token", prefix: "" },
      ],
    };
    expect(mcpAuthTemplateFromEditorValue(value)).toEqual({
      kind: "header",
      headerName: "X-Token",
    });
  });
});

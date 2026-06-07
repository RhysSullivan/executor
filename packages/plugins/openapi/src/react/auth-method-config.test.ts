import { describe, expect, it } from "@effect/vitest";
import { AuthTemplateSlug } from "@executor-js/sdk/shared";
import type { AuthTemplateEditorValue } from "@executor-js/react/components/auth-template-editor";

import {
  authenticationFromEditorValue,
  editorValueFromAuthentication,
  templateFromPlacements,
} from "./auth-method-config";
import { TOKEN_VARIABLE, variable, type Authentication } from "../sdk/types";

describe("editorValueFromAuthentication", () => {
  it("maps a bearer apiKey header template → an apikey editor value with prefix", () => {
    const template: Authentication = {
      slug: AuthTemplateSlug.make("apikey-0"),
      type: "apiKey",
      headers: { Authorization: ["Bearer ", variable(TOKEN_VARIABLE)] },
    };
    expect(editorValueFromAuthentication(template)).toEqual({
      kind: "apikey",
      placements: [
        { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "token" },
      ],
    });
  });

  it("maps a query apiKey template → an apikey editor value (empty prefix)", () => {
    const template: Authentication = {
      slug: AuthTemplateSlug.make("apikey-1"),
      type: "apiKey",
      queryParams: { api_key: [variable(TOKEN_VARIABLE)] },
    };
    expect(editorValueFromAuthentication(template)).toEqual({
      kind: "apikey",
      placements: [{ carrier: "query", name: "api_key", prefix: "", variable: "token" }],
    });
  });

  it("maps an oauth template → an oauth editor value carrying endpoints + scopes", () => {
    const template: Authentication = {
      slug: AuthTemplateSlug.make("oauth-google"),
      type: "oauth",
      authorizationUrl: "https://accounts.example.com/o/oauth2/auth",
      tokenUrl: "https://oauth2.example.com/token",
      scopes: ["openid", "email"],
    };
    expect(editorValueFromAuthentication(template)).toEqual({
      kind: "oauth",
      authorizationUrl: "https://accounts.example.com/o/oauth2/auth",
      tokenUrl: "https://oauth2.example.com/token",
      scopes: ["openid", "email"],
    });
  });
});

describe("authenticationFromEditorValue", () => {
  it("returns null for a 'none' value (nothing to register)", () => {
    expect(authenticationFromEditorValue({ kind: "none" })).toBeNull();
  });

  it("builds an apiKey template from placements, stamping the slug", () => {
    const value: AuthTemplateEditorValue = {
      kind: "apikey",
      placements: [{ carrier: "header", name: "X-Token", prefix: "" }],
    };
    expect(authenticationFromEditorValue(value, "custom_x")).toEqual(
      templateFromPlacements(value.placements, "custom_x"),
    );
  });

  it("builds an oauth template from an oauth value", () => {
    const value: AuthTemplateEditorValue = {
      kind: "oauth",
      authorizationUrl: "https://a.example.com/auth",
      tokenUrl: "https://a.example.com/token",
      scopes: ["read"],
    };
    expect(authenticationFromEditorValue(value, "oauth-0")).toEqual({
      slug: AuthTemplateSlug.make("oauth-0"),
      type: "oauth",
      authorizationUrl: "https://a.example.com/auth",
      tokenUrl: "https://a.example.com/token",
      scopes: ["read"],
    });
  });
});

describe("round-trip (apiKey + oauth)", () => {
  it("apiKey: editorValue ∘ authentication is identity for the placement shape", () => {
    const template: Authentication = {
      slug: AuthTemplateSlug.make("apikey-0"),
      type: "apiKey",
      headers: { Authorization: ["Bearer ", variable(TOKEN_VARIABLE)] },
    };
    const value = editorValueFromAuthentication(template);
    const back = authenticationFromEditorValue(value, "apikey-0");
    expect(back).toEqual(template);
  });

  it("oauth: editorValue ∘ authentication preserves endpoints + scopes", () => {
    const template: Authentication = {
      slug: AuthTemplateSlug.make("oauth-x"),
      type: "oauth",
      authorizationUrl: "https://a.example.com/auth",
      tokenUrl: "https://a.example.com/token",
      scopes: ["read", "write"],
    };
    const back = authenticationFromEditorValue(editorValueFromAuthentication(template), "oauth-x");
    expect(back).toEqual(template);
  });
});

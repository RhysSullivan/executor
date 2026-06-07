import { describe, expect, it } from "@effect/vitest";
import { AuthTemplateSlug } from "@executor-js/sdk/shared";

import {
  applyAuthTemplate,
  findAuthTemplate,
  renderAuthTemplate,
  requiredVariables,
} from "./template";
import { variable, type Authentication } from "./types";

// removed: the v1 `httpCredentialsFromConfiguredCredentialBindings` test
// (react/http-credentials.test.ts) — it exercised the v1 secret/scope/binding
// model (ScopeId + SecretId + ConfiguredCredentialBinding + per-header slots),
// all deleted in v2. In v2 a connection IS the credential and its value renders
// through the integration's auth template, which the cases below cover.

const apiKeyHeader: Authentication = {
  slug: AuthTemplateSlug.make("apiKey-header"),
  type: "apiKey",
  headers: { Authorization: ["Bearer ", variable("token")] },
};

const apiKeyQuery: Authentication = {
  slug: AuthTemplateSlug.make("apiKey-query"),
  type: "apiKey",
  queryParams: { api_key: [variable("token")] },
};

const oauth: Authentication = {
  slug: AuthTemplateSlug.make("oauth"),
  type: "oauth",
  authorizationUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  scopes: ["read"],
};

// Two distinct credential inputs on one method (e.g. Datadog) — each header
// renders from its own variable.
const datadog: Authentication = {
  slug: AuthTemplateSlug.make("datadog"),
  type: "apiKey",
  headers: {
    "DD-API-KEY": [variable("dd_api_key")],
    "DD-APPLICATION-KEY": [variable("dd_application_key")],
  },
};

describe("renderAuthTemplate", () => {
  it("renders an apiKey header template, substituting the credential variable", () => {
    const rendered = renderAuthTemplate(apiKeyHeader, { token: "sk-123" });
    expect(rendered.headers).toEqual({ Authorization: "Bearer sk-123" });
    expect(rendered.queryParams).toEqual({});
  });

  it("renders an apiKey query template", () => {
    const rendered = renderAuthTemplate(apiKeyQuery, { token: "qtoken" });
    expect(rendered.queryParams).toEqual({ api_key: "qtoken" });
    expect(rendered.headers).toEqual({});
  });

  it("renders two distinct inputs into their own headers, no cross-bleed", () => {
    const rendered = renderAuthTemplate(datadog, { dd_api_key: "a", dd_application_key: "b" });
    expect(rendered.headers).toEqual({ "DD-API-KEY": "a", "DD-APPLICATION-KEY": "b" });
  });

  it("renders an oauth access token exactly like a bearer apiKey (D11)", () => {
    const rendered = renderAuthTemplate(oauth, { token: "access-tok" });
    expect(rendered.headers).toEqual({ Authorization: "Bearer access-tok" });
  });

  it("renders nothing for oauth when the token input is unresolved", () => {
    expect(renderAuthTemplate(oauth, {})).toEqual({ headers: {}, queryParams: {} });
  });

  it("renders nothing when the template is absent", () => {
    expect(renderAuthTemplate(undefined, { token: "v" })).toEqual({
      headers: {},
      queryParams: {},
    });
  });
});

describe("requiredVariables", () => {
  it("lists the single token for oauth", () => {
    expect(requiredVariables(oauth)).toEqual(["token"]);
  });

  it("lists every distinct variable across an apiKey method's placements", () => {
    expect([...requiredVariables(datadog)].sort()).toEqual(["dd_api_key", "dd_application_key"]);
  });
});

describe("findAuthTemplate / applyAuthTemplate", () => {
  const templates: readonly Authentication[] = [apiKeyHeader, apiKeyQuery, oauth];

  it("finds a template by its slug", () => {
    expect(findAuthTemplate(templates, AuthTemplateSlug.make("oauth"))).toBe(oauth);
    expect(findAuthTemplate(templates, AuthTemplateSlug.make("missing"))).toBeUndefined();
  });

  it("selects the connection's template by slug and renders it", () => {
    const rendered = applyAuthTemplate(templates, AuthTemplateSlug.make("apiKey-query"), {
      token: "abc",
    });
    expect(rendered.queryParams).toEqual({ api_key: "abc" });
  });

  it("renders nothing when the connection's template slug doesn't match", () => {
    const rendered = applyAuthTemplate(templates, AuthTemplateSlug.make("nope"), { token: "abc" });
    expect(rendered).toEqual({ headers: {}, queryParams: {} });
  });
});

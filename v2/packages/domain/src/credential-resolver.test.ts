import { describe, expect, it } from "@effect/vitest";
import type { OAuthToken, SourceCredentialBinding } from "@executor-v2/schema";

import {
  buildCredentialHeaders,
  extractCredentialResolutionContext,
  selectCredentialBinding,
  selectOAuthAccessToken,
} from "./credential-resolver";

const now = Date.now();

const makeBinding = (
  partial: Partial<SourceCredentialBinding>,
): SourceCredentialBinding => ({
  id: "bind_1" as SourceCredentialBinding["id"],
  credentialId: "cred_1" as SourceCredentialBinding["credentialId"],
  organizationId: "org_1" as SourceCredentialBinding["organizationId"],
  workspaceId: "ws_1" as SourceCredentialBinding["workspaceId"],
  accountId: null,
  scopeType: "workspace",
  sourceKey: "source:src_1",
  provider: "bearer",
  secretRef: "secret",
  additionalHeadersJson: null,
  boundAuthFingerprint: null,
  createdAt: now,
  updatedAt: now,
  ...partial,
});

const makeOAuthToken = (partial: Partial<OAuthToken>): OAuthToken => ({
  id: "oauth_1" as OAuthToken["id"],
  workspaceId: "ws_1" as OAuthToken["workspaceId"],
  organizationId: "org_1" as OAuthToken["organizationId"],
  accountId: null,
  sourceId: "src_1" as OAuthToken["sourceId"],
  issuer: "issuer",
  accessTokenRef: "token_ref",
  refreshTokenRef: null,
  scope: ["read"],
  expiresAt: now + 60_000,
  createdAt: now,
  updatedAt: now,
  ...partial,
});

describe("credential resolver helpers", () => {
  it("extractCredentialResolutionContext returns null without context", () => {
  expect(
    extractCredentialResolutionContext({
      runId: "run_1",
      callId: "call_1",
      toolPath: "tools.executor.sources.list",
      input: {},
    }),
  ).toBeNull();
});

it("selectCredentialBinding prefers account over workspace over org", () => {
  const context = {
    workspaceId: "ws_1",
    sourceKey: "source:src_1",
    organizationId: "org_1",
    accountId: "acc_1",
  };

  const organizationBinding = makeBinding({
    id: "bind_org" as SourceCredentialBinding["id"],
    scopeType: "organization",
    workspaceId: null,
    accountId: null,
    updatedAt: now - 20,
  });

  const workspaceBinding = makeBinding({
    id: "bind_ws" as SourceCredentialBinding["id"],
    scopeType: "workspace",
    workspaceId: "ws_1" as SourceCredentialBinding["workspaceId"],
    accountId: null,
    updatedAt: now - 10,
  });

  const accountBinding = makeBinding({
    id: "bind_acc" as SourceCredentialBinding["id"],
    scopeType: "account",
    workspaceId: null,
    accountId: "acc_1" as SourceCredentialBinding["accountId"],
    updatedAt: now,
  });

  const selected = selectCredentialBinding(
    [organizationBinding, workspaceBinding, accountBinding],
    context,
  );

  expect(selected?.id).toBe(accountBinding.id);
});

it("selectOAuthAccessToken ignores expired tokens and picks scope match", () => {
  const context = {
    workspaceId: "ws_1",
    sourceKey: "source:src_1",
    organizationId: "org_1",
    accountId: "acc_1",
  };

  const expired = makeOAuthToken({
    id: "oauth_expired" as OAuthToken["id"],
    accountId: "acc_1" as OAuthToken["accountId"],
    accessTokenRef: "expired",
    expiresAt: now - 100,
  });

  const accountScoped = makeOAuthToken({
    id: "oauth_account" as OAuthToken["id"],
    accountId: "acc_1" as OAuthToken["accountId"],
    accessTokenRef: "account_token",
    expiresAt: now + 100_000,
  });

  const selected = selectOAuthAccessToken(
    [expired, accountScoped],
    context,
    "src_1",
  );

  expect(selected).toBe("account_token");
});

it("buildCredentialHeaders merges auth and additional headers", () => {
  const binding = makeBinding({
    provider: "api_key",
    secretRef: "abc123",
    additionalHeadersJson: JSON.stringify({
      "x-extra": "1",
    }),
  });

  const headers = buildCredentialHeaders(binding, {
    oauthAccessToken: null,
  });

  expect(headers["x-api-key"]).toBe("abc123");
  expect(headers["x-extra"]).toBe("1");
  });
});

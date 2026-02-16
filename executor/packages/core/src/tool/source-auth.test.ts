import { expect, test } from "bun:test";
import {
  buildCredentialAuthHeaders,
  buildCredentialSpec,
  buildStaticAuthHeaders,
  readCredentialOverrideHeaders,
} from "./source-auth";

test("buildStaticAuthHeaders returns static bearer header", () => {
  const headers = buildStaticAuthHeaders({
    type: "bearer",
    mode: "static",
    token: "secret-token",
  });

  expect(headers).toEqual({ authorization: "Bearer secret-token" });
});

test("buildCredentialSpec omits static auth and preserves account mode", () => {
  expect(buildCredentialSpec("source:test", { type: "none" })).toBeUndefined();
  expect(
    buildCredentialSpec("source:test", {
      type: "apiKey",
      mode: "account",
      header: "x-api-key",
    }),
  ).toEqual({
    sourceKey: "source:test",
    mode: "account",
    authType: "apiKey",
    headerName: "x-api-key",
  });
});

test("buildCredentialAuthHeaders supports bearer token aliases", () => {
  const headers = buildCredentialAuthHeaders(
    { authType: "bearer" },
    { accessToken: "  token-123  " },
  );

  expect(headers).toEqual({ authorization: "Bearer token-123" });
});

test("buildCredentialAuthHeaders supports apiKey aliases and explicit header", () => {
  const headers = buildCredentialAuthHeaders(
    { authType: "apiKey", headerName: "x-custom-key" },
    { apiKey: "api-value", headerName: "x-ignored" },
  );

  expect(headers).toEqual({ "x-custom-key": "api-value" });
});

test("buildCredentialAuthHeaders supports basic auth aliases", () => {
  const headers = buildCredentialAuthHeaders(
    { authType: "basic" },
    { user: "alice", pass: "hunter2" },
  );

  expect(headers).toEqual({
    authorization: `Basic ${Buffer.from("alice:hunter2", "utf8").toString("base64")}`,
  });
});

test("readCredentialOverrideHeaders trims keys and coerces values", () => {
  const headers = readCredentialOverrideHeaders({
    headers: {
      " x-trace-id ": "trace-1",
      "": "ignored",
      "x-retry": 2,
    },
  });

  expect(headers).toEqual({
    "x-trace-id": "trace-1",
    "x-retry": "2",
  });
});

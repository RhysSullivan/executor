import { expect, test } from "bun:test";
import {
  buildCredentialAuthHeaders,
  buildCredentialSpec,
  normalizeCredentialAdditionalHeaders,
  readCredentialAdditionalHeaders,
} from "./source-auth";

test("buildCredentialSpec defaults mode to workspace and preserves account mode", () => {
  expect(buildCredentialSpec("source:test", { type: "none" })).toBeUndefined();
  expect(
    buildCredentialSpec("source:test", {
      type: "bearer",
    }),
  ).toEqual({
    sourceKey: "source:test",
    mode: "workspace",
    authType: "bearer",
  });
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

test("readCredentialAdditionalHeaders trims keys and filters reserved names", () => {
  const headers = readCredentialAdditionalHeaders([
    { name: " x-trace-id ", value: "trace-1" },
    { name: "", value: "ignored" },
    { name: "authorization", value: "blocked" },
    { name: "x-retry", value: 2 },
  ]);

  expect(headers).toEqual({
    "x-trace-id": "trace-1",
    "x-retry": "2",
  });
});

test("normalizeCredentialAdditionalHeaders deduplicates by header name", () => {
  const headers = normalizeCredentialAdditionalHeaders([
    { name: "x-tenant-id", value: "acme" },
    { name: "X-TENANT-ID", value: "acme-2" },
  ]);

  expect(headers).toEqual([
    { name: "X-TENANT-ID", value: "acme-2" },
  ]);
});

import { expect, test } from "bun:test";
import { resolveCredentialPayload } from "./credential_providers";

test("managed provider returns stored payload", async () => {
  const payload = await resolveCredentialPayload({
    provider: "managed",
    secretJson: { token: "managed-token" },
  });

  expect(payload).toEqual({ token: "managed-token" });
});

test("WorkOS Vault provider reads object and parses JSON", async () => {
  let capturedObjectId = "";
  const payload = await resolveCredentialPayload(
    {
      provider: "workos-vault",
      secretJson: { objectId: "secret_123" },
    },
    {
      readVaultObject: async ({ objectId }) => {
        capturedObjectId = objectId;
        return '{"token":"vault-token","headerName":"x-api-key"}';
      },
    },
  );

  expect(capturedObjectId).toBe("secret_123");
  expect(payload).toEqual({ token: "vault-token", headerName: "x-api-key" });
});

test("WorkOS Vault provider falls back to id key and raw token", async () => {
  const payload = await resolveCredentialPayload(
    {
      provider: "workos-vault",
      secretJson: { id: "secret_456" },
    },
    {
      readVaultObject: async ({ objectId }) => {
        expect(objectId).toBe("secret_456");
        return "ghp_raw_token";
      },
    },
  );

  expect(payload).toEqual({ token: "ghp_raw_token" });
});

test("WorkOS Vault provider gives actionable error on missing reference", async () => {
  await expect(
    resolveCredentialPayload({
      provider: "workos-vault",
      secretJson: {},
    }),
  ).rejects.toThrow("Re-save this credential");
});

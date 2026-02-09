"use node";

import { WorkOS } from "@workos-inc/node";
import type { CredentialProvider, CredentialRecord } from "./types";
import { asRecord } from "./utils";

type CredentialPayload = Record<string, unknown>;

interface VaultReadInput {
  objectId: string;
  apiKey?: string;
}

type VaultObjectReader = (input: VaultReadInput) => Promise<string>;

type ProviderResolver = (
  record: Pick<CredentialRecord, "provider" | "secretJson">,
  readVaultObject: VaultObjectReader,
) => Promise<CredentialPayload | null>;

function resolveWorkosApiKey(explicitApiKey?: string): string {
  const candidate =
    explicitApiKey?.trim() ||
    process.env.WORKOS_API_KEY?.trim() ||
    "";

  if (!candidate) {
    throw new Error("WorkOS Vault provider requires WORKOS_API_KEY");
  }

  return candidate;
}

function isRetryableVaultError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("not yet ready") ||
    message.includes("can be retried") ||
    (message.includes("kek") && message.includes("ready"))
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withVaultRetry<T>(operation: () => Promise<T>): Promise<T> {
  const maxAttempts = 5;
  let delayMs = 250;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableVaultError(error) || attempt === maxAttempts) {
        throw error;
      }
      await sleep(delayMs);
      delayMs *= 2;
    }
  }

  throw new Error("Unreachable retry state");
}

async function defaultReadVaultObject(input: VaultReadInput): Promise<string> {
  const workos = new WorkOS(resolveWorkosApiKey(input.apiKey));
  const object = await withVaultRetry(async () => {
    return await workos.vault.readObject({ id: input.objectId });
  });
  const value = typeof object.value === "string" ? object.value : "";
  if (!value.trim()) {
    throw new Error(`WorkOS Vault object '${input.objectId}' returned an empty value`);
  }
  return value;
}

function parseSecretValue(raw: string): CredentialPayload {
  const value = raw.trim();
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    const asObject = asRecord(parsed);
    if (Object.keys(asObject).length > 0) {
      return asObject;
    }
  } catch {
    // not JSON; fall through
  }

  return { token: value };
}

function requireString(config: Record<string, unknown>, key: string, providerName: string): string {
  const value = config[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Credential provider '${providerName}' requires secretJson.${key}`);
  }
  return value.trim();
}

async function resolveManaged(
  record: Pick<CredentialRecord, "secretJson">,
): Promise<CredentialPayload | null> {
  return asRecord(record.secretJson);
}

async function resolveWorkosVault(
  record: Pick<CredentialRecord, "secretJson">,
  readVaultObject: VaultObjectReader,
): Promise<CredentialPayload | null> {
  const config = asRecord(record.secretJson);
  const objectId =
    typeof config.objectId === "string" && config.objectId.trim()
      ? config.objectId.trim()
      : typeof config.id === "string" && config.id.trim()
        ? config.id.trim()
        : "";

  if (!objectId) {
    // Backward compatibility: older rows may have stored credential payload directly
    // under the encrypted provider before object references were persisted.
    const { objectId: _objectId, id: _id, apiKey: _apiKey, ...legacyPayload } = config;
    const normalized = asRecord(legacyPayload);
    if (Object.keys(normalized).length > 0) {
      return normalized;
    }

    throw new Error(
      "Encrypted credential is missing its secure reference. Re-save this credential in the dashboard.",
    );
  }
  const apiKey = typeof config.apiKey === "string" && config.apiKey.trim() ? config.apiKey.trim() : undefined;

  const raw = await readVaultObject({ objectId, apiKey });
  return parseSecretValue(raw);
}

const providers: Record<CredentialProvider, ProviderResolver> = {
  managed: resolveManaged,
  "workos-vault": resolveWorkosVault,
};

export async function resolveCredentialPayload(
  record: Pick<CredentialRecord, "provider" | "secretJson">,
  options?: { readVaultObject?: VaultObjectReader },
): Promise<CredentialPayload | null> {
  const provider = (record.provider ?? "managed") as CredentialProvider;
  const resolver = providers[provider];
  if (!resolver) {
    throw new Error(`Unsupported credential provider: ${provider}`);
  }

  return await resolver(record, options?.readVaultObject ?? defaultReadVaultObject);
}

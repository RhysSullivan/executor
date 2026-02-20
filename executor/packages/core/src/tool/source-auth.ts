import type { OpenApiAuth } from "./source-types";
import type { CredentialAdditionalHeader, ToolCredentialAuthType, ToolCredentialSpec } from "../types";
import { z } from "zod";

export type CredentialHeaderAuthSpec = {
  authType: ToolCredentialAuthType;
  headerName?: string;
};

const secretRecordSchema = z.record(z.unknown());
const credentialAdditionalHeadersSchema = z.array(z.object({
  name: z.string(),
  value: z.coerce.string(),
}));
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const RESERVED_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
]);

function toRecord(value: unknown): Record<string, unknown> {
  const parsed = secretRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function getTrimmedString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function readSecretValue(record: Record<string, unknown>, aliases: string[]): string {
  const entries = new Map<string, unknown>();
  for (const [key, value] of Object.entries(record)) {
    entries.set(key.toLowerCase(), value);
  }

  for (const alias of aliases) {
    const value = entries.get(alias.toLowerCase());
    const trimmed = getTrimmedString(value);
    if (trimmed) {
      return trimmed;
    }
  }

  return "";
}

export function buildCredentialAuthHeaders(
  auth: CredentialHeaderAuthSpec,
  secret: unknown,
): Record<string, string> {
  const payload = toRecord(secret);

  if (auth.authType === "bearer") {
    const token = readSecretValue(payload, ["token", "accessToken", "bearerToken", "value"]);
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  if (auth.authType === "apiKey") {
    const discoveredHeader = readSecretValue(payload, ["headerName", "header", "keyName"]);
    const headerName = (auth.headerName ?? discoveredHeader) || "x-api-key";
    const value = readSecretValue(payload, ["value", "token", "apiKey", "key", "accessToken"]);
    return value ? { [headerName]: value } : {};
  }

  const username = readSecretValue(payload, ["username", "user"]);
  const password = readSecretValue(payload, ["password", "pass"]);
  if (!username && !password) {
    return {};
  }

  const encoded = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return { authorization: `Basic ${encoded}` };
}

export function normalizeCredentialAdditionalHeaders(value: unknown): CredentialAdditionalHeader[] {
  const parsed = credentialAdditionalHeadersSchema.safeParse(value);
  const rawHeaders = parsed.success ? parsed.data : [];

  const dedupedByName = new Map<string, CredentialAdditionalHeader>();
  for (const entry of rawHeaders) {
    const name = entry.name.trim();
    const value = entry.value.trim();
    if (!name || !value) continue;

    const normalizedName = name.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(name)) continue;
    if (RESERVED_HEADER_NAMES.has(normalizedName)) continue;

    dedupedByName.set(normalizedName, {
      name,
      value,
    });
  }

  return [...dedupedByName.values()];
}

export function readCredentialAdditionalHeaders(value: unknown): Record<string, string> {
  const headers = normalizeCredentialAdditionalHeaders(value);

  const normalized: Record<string, string> = {};
  for (const header of headers) {
    normalized[header.name] = header.value;
  }

  return normalized;
}

export function buildCredentialSpec(sourceKey: string, auth?: OpenApiAuth): ToolCredentialSpec | undefined {
  if (!auth || auth.type === "none") return undefined;
  const mode = auth.mode ?? "workspace";

  if (auth.type === "bearer") {
    return {
      sourceKey,
      mode,
      authType: "bearer",
    };
  }

  if (auth.type === "basic") {
    return {
      sourceKey,
      mode,
      authType: "basic",
    };
  }

  return {
    sourceKey,
    mode,
    authType: "apiKey",
    headerName: auth.header,
  };
}

export function getCredentialSourceKey(config: {
  type: "mcp" | "openapi" | "graphql";
  name: string;
  sourceKey?: string;
}): string {
  return config.sourceKey ?? `${config.type}:${config.name}`;
}

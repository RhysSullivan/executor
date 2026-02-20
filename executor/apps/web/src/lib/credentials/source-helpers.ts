import { displaySourceName } from "@/lib/tool/source-utils";
import {
  readSourceAuth,
  sourceForCredentialKey,
  type SourceAuthMode,
  type SourceAuthType,
} from "@/lib/tools/source-helpers";
import type {
  CredentialAdditionalHeader,
  CredentialScope,
  SourceAuthProfile,
  ToolSourceScopeType,
  ToolSourceRecord,
} from "@/lib/types";

export type SourceOption = { source: ToolSourceRecord; key: string; label: string };

export function ownerScopeLabel(scopeType: ToolSourceScopeType | undefined): string {
  return scopeType === "organization" ? "organization" : "workspace";
}

export function sourceAuthForKey(
  sourceOptions: SourceOption[],
  key: string,
  inferredProfiles: Record<string, SourceAuthProfile> = {},
): {
  type: SourceAuthType;
  mode?: SourceAuthMode;
  header?: string;
  inferred?: boolean;
} {
  const match = sourceOptions.find((entry) => entry.key === key);
  if (!match) {
    return { type: "bearer" };
  }
  const inferredProfile = inferredProfiles[key];
  return readSourceAuth(match.source, inferredProfile);
}

export function sourceOptionLabel(source: ToolSourceRecord): string {
  return `${source.name} (${source.type}, ${ownerScopeLabel(source.scopeType)})`;
}

export function providerLabel(provider: "local-convex" | "workos-vault"): string {
  return provider === "workos-vault" ? "encrypted" : "local";
}

export function connectionDisplayName(
  sources: ToolSourceRecord[],
  connection: {
    scope: CredentialScope;
    scopeType?: ToolSourceScopeType;
    sourceKeys: Set<string>;
    accountId?: string;
  },
): string {
  const sourceNames = [...connection.sourceKeys]
    .map((sourceKey) => sourceForCredentialKey(sources, sourceKey))
    .filter((source): source is ToolSourceRecord => Boolean(source))
    .map((source) => displaySourceName(source.name));

  const primary = sourceNames[0] ?? "API";
  const extraCount = Math.max(sourceNames.length - 1, 0);
  const base = extraCount > 0 ? `${primary} +${extraCount}` : primary;

  if (connection.scope === "account") {
    if (connection.accountId) {
      return `${base} personal (${connection.accountId})`;
    }
    return `${base} personal`;
  }

  return `${base} ${ownerScopeLabel(connection.scopeType)}`;
}

type AdditionalHeadersParseResult = {
  value?: Record<string, string>;
  error?: string;
};

export function parseAdditionalHeadersText(text: string): AdditionalHeadersParseResult {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { value: {} };
  }

  const headers: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      return { error: `Invalid header line: ${line}` };
    }
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!name || !value) {
      return { error: `Invalid header line: ${line}` };
    }
    headers[name] = value;
  }

  return { value: headers };
}

export type AdditionalHeaderEntry = {
  key: string;
  value: string;
};

export function parseAdditionalHeaderEntries(text: string): AdditionalHeaderEntry[] {
  const rows = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rows.length === 0) {
    return [{ key: "", value: "" }];
  }

  return rows.map((row) => {
    const separator = row.indexOf(":");
    if (separator <= 0) {
      return { key: row.trim(), value: "" };
    }

    return {
      key: row.slice(0, separator).trim(),
      value: row.slice(separator + 1).trim(),
    };
  });
}

export function parseAdditionalHeaderRows(entries: AdditionalHeaderEntry[]): AdditionalHeadersParseResult {
  const headers: Record<string, string> = {};

  for (let index = 0; index < entries.length; index += 1) {
    const rawKey = entries[index]?.key ?? "";
    const rawValue = entries[index]?.value ?? "";
    const key = rawKey.trim();
    const value = rawValue.trim();

    if (!key && !value) {
      continue;
    }

    if (!key || !value) {
      return { error: `Invalid header row ${index + 1}` };
    }

    headers[key] = value;
  }

  return { value: headers };
}

export function serializeAdditionalHeaderRows(entries: AdditionalHeaderEntry[]): string {
  return entries
    .map((entry) => ({
      key: entry.key.trim(),
      value: entry.value.trim(),
    }))
    .filter((entry) => entry.key.length > 0 && entry.value.length > 0)
    .map((entry) => `${entry.key}: ${entry.value}`)
    .join("\n");
}

export function formatAdditionalHeaders(headers: CredentialAdditionalHeader[] | undefined): string {
  return (headers ?? [])
    .map((header) => ({
      key: header.name.trim(),
      value: header.value.trim(),
    }))
    .filter((entry) => entry.key.length > 0 && entry.value.length > 0)
    .map((entry) => `${entry.key}: ${entry.value}`)
    .join("\n");
}

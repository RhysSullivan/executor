import { displaySourceName } from "@/lib/tool/source-utils";
import {
  readSourceAuth,
  sourceForCredentialKey,
  toolSourceLabelForSource,
  type SourceAuthMode,
  type SourceAuthType,
} from "@/lib/tools/source-helpers";
import type {
  CredentialScope,
  OwnerScopeType,
  SourceAuthProfile,
  ToolSourceRecord,
} from "@/lib/types";

export type SourceOption = { source: ToolSourceRecord; key: string; label: string };

export function ownerScopeLabel(ownerScopeType: OwnerScopeType | undefined): string {
  return ownerScopeType === "organization" ? "organization" : "workspace";
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
  const inferredProfile = inferredProfiles[key] ?? inferredProfiles[toolSourceLabelForSource(match.source)];
  return readSourceAuth(match.source, inferredProfile);
}

export function sourceOptionLabel(source: ToolSourceRecord): string {
  return `${source.name} (${source.type}, ${ownerScopeLabel(source.ownerScopeType)})`;
}

export function providerLabel(provider: "local-convex" | "workos-vault"): string {
  return provider === "workos-vault" ? "encrypted" : "local";
}

export function connectionDisplayName(
  sources: ToolSourceRecord[],
  connection: {
    scope: CredentialScope;
    ownerScopeType?: OwnerScopeType;
    sourceKeys: Set<string>;
    actorId?: string;
  },
): string {
  const sourceNames = [...connection.sourceKeys]
    .map((sourceKey) => sourceForCredentialKey(sources, sourceKey))
    .filter((source): source is ToolSourceRecord => Boolean(source))
    .map((source) => displaySourceName(source.name));

  const primary = sourceNames[0] ?? "API";
  const extraCount = Math.max(sourceNames.length - 1, 0);
  const base = extraCount > 0 ? `${primary} +${extraCount}` : primary;

  if (connection.scope === "actor") {
    if (connection.actorId) {
      return `${base} personal (${connection.actorId})`;
    }
    return `${base} personal`;
  }

  return `${base} ${ownerScopeLabel(connection.ownerScopeType)}`;
}

export function parseHeaderOverrides(text: string): { value?: Record<string, string>; error?: string } {
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

export function formatHeaderOverrides(overrides: Record<string, unknown> | undefined): string {
  const headers = overrides && typeof overrides.headers === "object" ? (overrides.headers as Record<string, unknown>) : {};
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
}

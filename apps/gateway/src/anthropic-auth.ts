import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export type ResolvedAnthropicAuth =
  | {
      mode: "api";
      apiKey: string;
      source: string;
    }
  | {
      mode: "oauth";
      accessToken: string;
      refreshToken: string | undefined;
      expiresAt: number | undefined;
      clientId: string;
      source: string;
    };

export async function resolveAnthropicAuth(): Promise<ResolvedAnthropicAuth | null> {
  const explicitApiKey = env("OPENASSISTANT_ANTHROPIC_API_KEY") ?? env("ANTHROPIC_API_KEY");
  if (explicitApiKey) {
    return {
      mode: "api",
      apiKey: explicitApiKey,
      source: env("OPENASSISTANT_ANTHROPIC_API_KEY") ? "env:OPENASSISTANT_ANTHROPIC_API_KEY" : "env:ANTHROPIC_API_KEY",
    };
  }

  const explicitAccess = env("OPENASSISTANT_ANTHROPIC_ACCESS_TOKEN");
  if (explicitAccess) {
    const refreshToken = env("OPENASSISTANT_ANTHROPIC_REFRESH_TOKEN");
    const expiresAt = parseMaybeNumber(env("OPENASSISTANT_ANTHROPIC_EXPIRES_AT"));
    return {
      mode: "oauth",
      accessToken: explicitAccess,
      refreshToken,
      expiresAt,
      clientId: env("OPENASSISTANT_ANTHROPIC_CLIENT_ID") ?? DEFAULT_ANTHROPIC_OAUTH_CLIENT_ID,
      source: "env:OPENASSISTANT_ANTHROPIC_ACCESS_TOKEN",
    };
  }

  const opencodeAuth = await loadOpencodeAnthropicAuth();
  if (opencodeAuth) {
    return opencodeAuth;
  }

  return null;
}

async function loadOpencodeAnthropicAuth(): Promise<ResolvedAnthropicAuth | null> {
  const filepath = join(opencodeDataDir(), "auth.json");
  const file = Bun.file(filepath);
  const exists = await file.exists();
  if (!exists) {
    return null;
  }

  const raw = (await file.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const anthropic = raw["anthropic"];
  if (!anthropic || typeof anthropic !== "object") {
    return null;
  }

  const record = anthropic as Record<string, unknown>;
  const type = asString(record["type"]);
  if (type === "api") {
    const key = asString(record["key"]);
    if (!key) {
      return null;
    }
    return {
      mode: "api",
      apiKey: key,
      source: "opencode:auth.json(api)",
    };
  }

  if (type === "oauth") {
    const accessToken = asString(record["access"]);
    if (!accessToken) {
      return null;
    }
    const refreshToken = asString(record["refresh"]);
    const expiresAt = asNumber(record["expires"]);

    return {
      mode: "oauth",
      accessToken,
      refreshToken,
      expiresAt,
      clientId: env("OPENASSISTANT_ANTHROPIC_CLIENT_ID") ?? DEFAULT_ANTHROPIC_OAUTH_CLIENT_ID,
      source: "opencode:auth.json(oauth)",
    };
  }

  return null;
}

function opencodeDataDir(): string {
  const xdg = env("XDG_DATA_HOME");
  if (xdg) {
    return join(xdg, "opencode");
  }
  return join(homedir(), ".local", "share", "opencode");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseMaybeNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function env(key: string): string | undefined {
  const bun = (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun;
  return bun?.env?.[key] ?? process.env[key];
}

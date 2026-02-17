import { SignJWT, jwtVerify } from "jose";
import type { Id } from "../../convex/_generated/dataModel.d.ts";
import { getAnonymousAuthIssuer } from "./anonymous";

export const MCP_API_KEY_ENV_NAME = "API_KEY";
const MCP_API_KEY_AUDIENCE = "executor-mcp";
const MCP_API_KEY_ALGORITHM = "HS256";

export type VerifiedMcpApiKey = {
  workspaceId: Id<"workspaces">;
  accountId: Id<"accounts">;
};

function trimOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizeSecret(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}

function getConfiguredSecret(): string | null {
  const explicit = trimOrNull(process.env.MCP_API_KEY_SECRET);
  if (explicit) {
    return normalizeSecret(explicit);
  }

  const anonymousPrivateKey = trimOrNull(process.env.ANONYMOUS_AUTH_PRIVATE_KEY_PEM);
  if (anonymousPrivateKey) {
    return normalizeSecret(anonymousPrivateKey);
  }

  return null;
}

function getIssuer(): string | null {
  return getAnonymousAuthIssuer();
}

function getSecretBytes(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export function isMcpApiKeyConfigured(): boolean {
  return Boolean(getConfiguredSecret());
}

export async function issueMcpApiKey(input: {
  workspaceId: Id<"workspaces">;
  accountId: Id<"accounts">;
}): Promise<string | null> {
  const secret = getConfiguredSecret();
  if (!secret) {
    return null;
  }

  const issuer = getIssuer();
  let jwt = new SignJWT({
    workspaceId: input.workspaceId,
    accountId: input.accountId,
  })
    .setProtectedHeader({ alg: MCP_API_KEY_ALGORITHM, typ: "JWT" })
    .setAudience(MCP_API_KEY_AUDIENCE)
    .setSubject(input.accountId)
    .setIssuedAt();

  if (issuer) {
    jwt = jwt.setIssuer(issuer);
  }

  return await jwt.sign(getSecretBytes(secret));
}

export async function verifyMcpApiKey(rawApiKey: string | null | undefined): Promise<VerifiedMcpApiKey | null> {
  const token = rawApiKey?.trim() ?? "";
  if (!token) {
    return null;
  }

  const secret = getConfiguredSecret();
  if (!secret) {
    return null;
  }

  const issuer = getIssuer();

  try {
    const { payload } = await jwtVerify(token, getSecretBytes(secret), {
      algorithms: [MCP_API_KEY_ALGORITHM],
      audience: MCP_API_KEY_AUDIENCE,
      ...(issuer ? { issuer } : {}),
    });

    const workspaceIdRaw = typeof payload.workspaceId === "string" ? payload.workspaceId.trim() : "";
    const accountIdRaw = typeof payload.accountId === "string"
      ? payload.accountId.trim()
      : typeof payload.sub === "string"
        ? payload.sub.trim()
        : "";

    if (!workspaceIdRaw || !accountIdRaw) {
      return null;
    }

    return {
      workspaceId: workspaceIdRaw as Id<"workspaces">,
      accountId: accountIdRaw as Id<"accounts">,
    };
  } catch {
    return null;
  }
}

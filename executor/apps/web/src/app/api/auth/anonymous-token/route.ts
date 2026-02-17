import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";

const anonymousTokenRequestSchema = z.object({
  accountId: z.string().trim().min(1).optional(),
});

const anonymousAuthAudience = "executor-anonymous";
const anonymousAuthKeyId = "executor-anonymous-es256";
const anonymousAuthTokenTtlSeconds = 60 * 60 * 24 * 7;
const configQueryTimeoutMs = 2_000;

function trimOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function normalizePem(value: string | undefined): string | null {
  const raw = trimOrNull(value);
  if (!raw) {
    return null;
  }
  return raw.replace(/\\n/g, "\n");
}

function toSiteUrl(raw?: string): string | null {
  const trimmed = trimOrNull(raw);
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.endsWith(".convex.cloud")) {
      parsed.hostname = parsed.hostname.replace(/\.convex\.cloud$/, ".convex.site");
    }
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function resolveIssuer(): string | null {
  return toSiteUrl(
    process.env.ANONYMOUS_AUTH_ISSUER
      ?? process.env.EXECUTOR_WEB_CONVEX_SITE_URL
      ?? process.env.CONVEX_SITE_URL
      ?? process.env.EXECUTOR_WEB_CONVEX_URL
      ?? process.env.CONVEX_URL
      ?? process.env.NEXT_PUBLIC_CONVEX_SITE_URL
      ?? process.env.NEXT_PUBLIC_CONVEX_URL,
  );
}

function resolveConvexUrl(): string | null {
  return trimOrNull(
    process.env.EXECUTOR_WEB_CONVEX_URL
      ?? process.env.CONVEX_URL
      ?? process.env.NEXT_PUBLIC_CONVEX_URL,
  );
}

async function resolveIssuerFromBackend(): Promise<string | null> {
  const convexUrl = resolveConvexUrl();
  if (!convexUrl) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), configQueryTimeoutMs);
  try {
    const response = await fetch(`${convexUrl}/api/query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: "app:getClientConfig",
        args: {},
      }),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const parsed = z.object({
      status: z.literal("success"),
      value: z.object({
        anonymousAuthIssuer: z.string().trim().min(1).nullable().optional(),
      }).optional(),
    }).safeParse(await response.json());

    if (!parsed.success) {
      return null;
    }

    return toSiteUrl(parsed.data.value?.anonymousAuthIssuer ?? undefined);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseTokenTtlSeconds(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : anonymousAuthTokenTtlSeconds;
}

function noStoreJson(payload: unknown, status: number): NextResponse {
  return NextResponse.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

let signingKeyPromise: Promise<CryptoKey> | null = null;

async function loadSigningKey(privateKeyPem: string): Promise<CryptoKey> {
  if (!signingKeyPromise) {
    signingKeyPromise = importPKCS8(privateKeyPem, "ES256");
  }
  return await signingKeyPromise;
}

function createAccountId(): string {
  return `anon_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function POST(request: NextRequest) {
  const issuer = await resolveIssuerFromBackend() ?? resolveIssuer();
  const privateKeyPem = normalizePem(process.env.ANONYMOUS_AUTH_PRIVATE_KEY_PEM);
  if (!issuer || !privateKeyPem) {
    return noStoreJson({ error: "Anonymous auth is not configured" }, 503);
  }

  let accountId: string;
  try {
    const parsed = anonymousTokenRequestSchema.safeParse(await request.json());
    accountId = parsed.success && parsed.data.accountId ? parsed.data.accountId : createAccountId();
  } catch {
    accountId = createAccountId();
  }

  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = nowSeconds + parseTokenTtlSeconds(process.env.ANONYMOUS_AUTH_TOKEN_TTL_SECONDS);
    const signingKey = await loadSigningKey(privateKeyPem);

    const accessToken = await new SignJWT({ provider: "anonymous" })
      .setProtectedHeader({ alg: "ES256", kid: anonymousAuthKeyId, typ: "JWT" })
      .setIssuer(issuer)
      .setSubject(accountId)
      .setAudience(anonymousAuthAudience)
      .setIssuedAt(nowSeconds)
      .setNotBefore(nowSeconds - 5)
      .setExpirationTime(expiresAtSeconds)
      .sign(signingKey);

    return noStoreJson(
      {
        tokenType: "Bearer",
        accessToken,
        accountId,
        expiresAtMs: expiresAtSeconds * 1000,
      },
      200,
    );
  } catch (error) {
    return noStoreJson(
      { error: error instanceof Error ? error.message : "Failed to issue anonymous token" },
      400,
    );
  }
}

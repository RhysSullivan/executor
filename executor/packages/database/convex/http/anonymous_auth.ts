import { exportJWK, importPKCS8, importSPKI, SignJWT } from "jose";
import { httpAction } from "../_generated/server";
import {
  ANONYMOUS_AUTH_AUDIENCE,
  ANONYMOUS_AUTH_KEY_ID,
  ANONYMOUS_AUTH_TOKEN_TTL_SECONDS,
  getAnonymousAuthIssuer,
} from "../../src/auth/anonymous";

type AnonymousTokenBody = {
  actorId?: string;
};

type AnonymousTokenConfig = {
  issuer: string | null;
  audience: string;
  keyId: string;
  tokenTtlSeconds: number;
  privateKeyPem: string | null;
  publicKeyPem: string | null;
};

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

function parseTokenTtlSeconds(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ANONYMOUS_AUTH_TOKEN_TTL_SECONDS;
}

function getAnonymousTokenConfig(): AnonymousTokenConfig {
  return {
    issuer: getAnonymousAuthIssuer(),
    audience: ANONYMOUS_AUTH_AUDIENCE,
    keyId: ANONYMOUS_AUTH_KEY_ID,
    tokenTtlSeconds: parseTokenTtlSeconds(process.env.ANONYMOUS_AUTH_TOKEN_TTL_SECONDS),
    privateKeyPem: normalizePem(process.env.ANONYMOUS_AUTH_PRIVATE_KEY_PEM),
    publicKeyPem: normalizePem(process.env.ANONYMOUS_AUTH_PUBLIC_KEY_PEM),
  };
}

function noStoreHeaders(extra?: Record<string, string>) {
  return {
    "cache-control": "no-store",
    ...extra,
  };
}

function parseAnonymousActorId(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const actorId = raw.trim();
  if (!actorId) {
    return null;
  }
  if (!/^anon_[a-zA-Z0-9_-]{8,}$/.test(actorId)) {
    throw new Error("actorId must match anon_<id>");
  }
  return actorId;
}

async function readActorIdFromRequest(request: Request): Promise<string | null> {
  const url = new URL(request.url);
  const queryActorId = url.searchParams.get("actorId");
  if (queryActorId) {
    return parseAnonymousActorId(queryActorId);
  }

  if (request.method !== "POST") {
    return null;
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  const body = (await request.json()) as AnonymousTokenBody;
  return parseAnonymousActorId(body.actorId);
}

function createActorId(): string {
  return `anon_${crypto.randomUUID().replace(/-/g, "")}`;
}

let signingKeyPromise: Promise<CryptoKey> | null = null;
let jwksPromise: Promise<Record<string, unknown>> | null = null;

async function loadSigningKey(privateKeyPem: string): Promise<CryptoKey> {
  if (!signingKeyPromise) {
    signingKeyPromise = importPKCS8(privateKeyPem, "ES256");
  }
  return await signingKeyPromise;
}

async function loadJwks(publicKeyPem: string, keyId: string): Promise<Record<string, unknown>> {
  if (!jwksPromise) {
    jwksPromise = (async () => {
      const verificationKey = await importSPKI(publicKeyPem, "ES256");
      const jwk = await exportJWK(verificationKey);
      return {
        keys: [
          {
            ...jwk,
            kid: keyId,
            alg: "ES256",
            use: "sig",
          },
        ],
      };
    })();
  }

  return await jwksPromise;
}

export const anonymousTokenHandler = httpAction(async (_ctx, request) => {
  const config = getAnonymousTokenConfig();
  if (!config.issuer || !config.privateKeyPem) {
    return Response.json(
      { error: "Anonymous auth is not configured" },
      { status: 503, headers: noStoreHeaders() },
    );
  }

  try {
    const actorId = (await readActorIdFromRequest(request)) ?? createActorId();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = nowSeconds + config.tokenTtlSeconds;
    const signingKey = await loadSigningKey(config.privateKeyPem);

    const accessToken = await new SignJWT({ provider: "anonymous" })
      .setProtectedHeader({ alg: "ES256", kid: config.keyId, typ: "JWT" })
      .setIssuer(config.issuer)
      .setSubject(actorId)
      .setAudience(config.audience)
      .setIssuedAt(nowSeconds)
      .setNotBefore(nowSeconds - 5)
      .setExpirationTime(expiresAtSeconds)
      .sign(signingKey);

    return Response.json(
      {
        tokenType: "Bearer",
        accessToken,
        actorId,
        expiresAtMs: expiresAtSeconds * 1000,
      },
      {
        status: 200,
        headers: noStoreHeaders(),
      },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to issue anonymous token" },
      { status: 400, headers: noStoreHeaders() },
    );
  }
});

export const anonymousJwksHandler = httpAction(async (_ctx, _request) => {
  const config = getAnonymousTokenConfig();
  if (!config.issuer || !config.publicKeyPem) {
    return Response.json(
      { error: "Anonymous auth is not configured" },
      { status: 503, headers: noStoreHeaders() },
    );
  }

  const jwks = await loadJwks(config.publicKeyPem, config.keyId);
  return Response.json(jwks, {
    status: 200,
    headers: noStoreHeaders({
      "content-type": "application/json",
    }),
  });
});

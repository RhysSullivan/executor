export type AnonymousAuthToken = {
  accessToken: string;
  actorId: string;
  expiresAtMs: number;
};

const TOKEN_STORAGE_KEY = "executor_anonymous_access_token";
const ACTOR_STORAGE_KEY = "executor_anonymous_actor_id";
const EXPIRES_STORAGE_KEY = "executor_anonymous_token_expires_at";
const TOKEN_EXPIRY_SKEW_MS = 60_000;

function canUseStorage(): boolean {
  return typeof window !== "undefined";
}

function readStorageValue(key: string): string | null {
  if (!canUseStorage()) {
    return null;
  }
  return localStorage.getItem(key);
}

function writeStorageValue(key: string, value: string) {
  if (!canUseStorage()) {
    return;
  }
  localStorage.setItem(key, value);
}

export function clearAnonymousAuth(options?: { clearActor?: boolean }) {
  if (!canUseStorage()) {
    return;
  }

  localStorage.removeItem(TOKEN_STORAGE_KEY);
  if (options?.clearActor) {
    localStorage.removeItem(ACTOR_STORAGE_KEY);
  }
  localStorage.removeItem(EXPIRES_STORAGE_KEY);
}

function persistAnonymousAuth(token: AnonymousAuthToken) {
  writeStorageValue(TOKEN_STORAGE_KEY, token.accessToken);
  writeStorageValue(ACTOR_STORAGE_KEY, token.actorId);
  writeStorageValue(EXPIRES_STORAGE_KEY, String(token.expiresAtMs));
}

function readStoredActorId(): string | null {
  const raw = readStorageValue(ACTOR_STORAGE_KEY);
  return raw && raw.trim().length > 0 ? raw.trim() : null;
}

export function readStoredAnonymousAuthToken(): AnonymousAuthToken | null {
  const accessToken = readStorageValue(TOKEN_STORAGE_KEY);
  const actorId = readStoredActorId();
  const expiresAtRaw = readStorageValue(EXPIRES_STORAGE_KEY);

  if (!accessToken || !actorId || !expiresAtRaw) {
    return null;
  }

  const expiresAtMs = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAtMs)) {
    clearAnonymousAuth();
    return null;
  }

  if (Date.now() + TOKEN_EXPIRY_SKEW_MS >= expiresAtMs) {
    clearAnonymousAuth();
    return null;
  }

  return {
    accessToken,
    actorId,
    expiresAtMs,
  };
}

async function requestAnonymousAuthToken(actorId?: string): Promise<AnonymousAuthToken> {
  const response = await fetch("/api/auth/anonymous-token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ actorId }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "Failed to obtain anonymous auth token");
  }

  const payload = await response.json() as {
    accessToken?: unknown;
    actorId?: unknown;
    expiresAtMs?: unknown;
  };

  if (
    typeof payload.accessToken !== "string"
    || typeof payload.actorId !== "string"
    || typeof payload.expiresAtMs !== "number"
  ) {
    throw new Error("Anonymous token response was malformed");
  }

  return {
    accessToken: payload.accessToken,
    actorId: payload.actorId,
    expiresAtMs: payload.expiresAtMs,
  };
}

export async function getAnonymousAuthToken(forceRefresh = false): Promise<AnonymousAuthToken> {
  if (!forceRefresh) {
    const stored = readStoredAnonymousAuthToken();
    if (stored) {
      return stored;
    }
  }

  const actorId = readStoredActorId() ?? undefined;
  const fresh = await requestAnonymousAuthToken(actorId);
  persistAnonymousAuth(fresh);
  return fresh;
}

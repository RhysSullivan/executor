const DAY_MS = 24 * 60 * 60 * 1000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export const ANONYMOUS_SESSION_TTL_MS = parsePositiveInt(
  process.env.ANONYMOUS_SESSION_TTL_MS,
  14 * DAY_MS,
);

export function resolveAnonymousSessionExpiresAt(session: {
  createdAt: number;
  expiresAt?: number;
}): number {
  if (typeof session.expiresAt === "number") {
    return session.expiresAt;
  }
  return session.createdAt + ANONYMOUS_SESSION_TTL_MS;
}

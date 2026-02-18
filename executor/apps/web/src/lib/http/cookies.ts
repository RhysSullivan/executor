type SameSite = "lax" | "strict" | "none";

type CookieOptions = {
  path?: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: SameSite;
};

function encodeValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) {
    return null;
  }

  const cookies = raw.split(";");
  for (const cookie of cookies) {
    const [rawName, ...rest] = cookie.trim().split("=");
    if (rawName !== name) {
      continue;
    }

    return decodeValue(rest.join("="));
  }

  return null;
}

function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeValue(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }

  parts.push(`Path=${options.path ?? "/"}`);

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (options.secure) {
    parts.push("Secure");
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  return parts.join("; ");
}

export function appendSetCookie(headers: Headers, name: string, value: string, options: CookieOptions = {}) {
  headers.append("Set-Cookie", serializeCookie(name, value, options));
}

export function appendDeleteCookie(headers: Headers, name: string, options: CookieOptions = {}) {
  headers.append(
    "Set-Cookie",
    serializeCookie(name, "", {
      ...options,
      maxAge: 0,
    }),
  );
}

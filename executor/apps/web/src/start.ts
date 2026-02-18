import { createStart } from "@tanstack/react-start";
import { authkitMiddleware } from "@workos/authkit-tanstack-react-start";

function trim(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
}

function workosRedirectUri(): string | undefined {
  return trim(process.env.WORKOS_REDIRECT_URI)
    ?? (trim(process.env.EXECUTOR_PUBLIC_ORIGIN)
      ? `${trim(process.env.EXECUTOR_PUBLIC_ORIGIN)}/callback`
      : undefined)
    ?? (trim(process.env.NODE_ENV) !== "production"
      ? `http://localhost:${trim(process.env.PORT) ?? "4312"}/callback`
      : undefined);
}

function workosConfigured(): boolean {
  return Boolean(
    trim(process.env.WORKOS_CLIENT_ID)
      && trim(process.env.WORKOS_API_KEY)
      && trim(process.env.WORKOS_COOKIE_PASSWORD),
  );
}

const resolvedWorkosRedirectUri = workosRedirectUri();

if (!trim(process.env.WORKOS_REDIRECT_URI) && resolvedWorkosRedirectUri) {
  process.env.WORKOS_REDIRECT_URI = resolvedWorkosRedirectUri;
}

export const startInstance = createStart(() => ({
  requestMiddleware: workosConfigured()
    ? [
      authkitMiddleware({
        redirectUri: resolvedWorkosRedirectUri,
      }),
    ]
    : [],
}));

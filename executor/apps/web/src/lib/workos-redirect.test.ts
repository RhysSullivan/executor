import { expect, test } from "bun:test";

import { resolveWorkosRedirectUri } from "./workos-redirect";

const WORKOS_ENV_KEYS = [
  "WORKOS_REDIRECT_URI",
  "NEXT_PUBLIC_WORKOS_REDIRECT_URI",
  "EXECUTOR_PUBLIC_ORIGIN",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_URL",
  "NEXT_PUBLIC_VERCEL_URL",
  "NODE_ENV",
] as const;

const originalWorkosEnv: Record<(typeof WORKOS_ENV_KEYS)[number], string | undefined> =
  WORKOS_ENV_KEYS.reduce((acc, key) => {
    acc[key] = process.env[key];
    return acc;
  }, {} as Record<(typeof WORKOS_ENV_KEYS)[number], string | undefined>);

function resetWorkosEnv() {
  for (const key of WORKOS_ENV_KEYS) {
    if (originalWorkosEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalWorkosEnv[key];
    }
  }
}

test("uses explicit WORKOS_REDIRECT_URI when set", () => {
  resetWorkosEnv();

  process.env.WORKOS_REDIRECT_URI = "https://app.example.com/callback";
  process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI = "https://public.example.com/callback";

  const request = new Request("https://request.example.com/sign-in");
  expect(resolveWorkosRedirectUri(request)).toBe("https://app.example.com/api/auth/callback");
});

test("falls back to NEXT_PUBLIC_WORKOS_REDIRECT_URI when server var is absent", () => {
  resetWorkosEnv();

  delete process.env.WORKOS_REDIRECT_URI;
  process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI = "https://public.example.com/callback";

  const request = new Request("https://request.example.com/sign-in");
  expect(resolveWorkosRedirectUri(request)).toBe("https://public.example.com/api/auth/callback");
});

test("derives from forwarded request origin when not explicitly configured", () => {
  resetWorkosEnv();

  delete process.env.WORKOS_REDIRECT_URI;
  delete process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI;

  const request = new Request("https://request.example.com/sign-in", {
    headers: {
      "x-forwarded-host": "executor.sh",
      "x-forwarded-proto": "https",
    },
  });

  expect(resolveWorkosRedirectUri(request)).toBe("https://executor.sh/api/auth/callback");
});

test("falls back to localhost when host cannot be derived locally", () => {
  resetWorkosEnv();

  delete process.env.WORKOS_REDIRECT_URI;
  delete process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI;
  delete process.env.EXECUTOR_PUBLIC_ORIGIN;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_URL;
  delete process.env.NEXT_PUBLIC_VERCEL_URL;
  process.env.NODE_ENV = "development";

  const request = new Request("http://localhost:1234/sign-in");
  expect(resolveWorkosRedirectUri(request)).toBe("http://localhost:1234/api/auth/callback");
});

resetWorkosEnv();

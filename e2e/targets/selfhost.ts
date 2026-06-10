// The self-host app as a target: its real dev server (`bunx --bun vite dev`)
// on a throwaway data dir, with Better Auth + the bootstrap admin. MCP OAuth
// is fully headless via the mcporter fork's cookieConsentStrategy. Boot lives
// in setup/selfhost.globalsetup.ts.
import { Effect } from "effect";

import { cookieConsentStrategy } from "../../vendor/mcporter/dist/index.js";

import type { Identity, Target } from "../src/target";

export const SELFHOST_PORT = Number(process.env.E2E_SELFHOST_PORT ?? 4799);
export const SELFHOST_BASE_URL =
  process.env.E2E_SELFHOST_URL ?? `http://localhost:${SELFHOST_PORT}`;

export const SELFHOST_ADMIN = {
  email: process.env.E2E_SELFHOST_ADMIN_EMAIL ?? "admin@e2e.test",
  password: process.env.E2E_SELFHOST_ADMIN_PASSWORD ?? "e2e-admin-password-123",
};

export const selfhostTarget = (): Target => ({
  name: "selfhost",
  baseUrl: SELFHOST_BASE_URL,
  mcpUrl: `${SELFHOST_BASE_URL}/mcp`,
  // No "billing" (no limits). Identity is the bootstrap admin for now —
  // single-tenant; per-test invite-signup isolation is the next step here.
  capabilities: new Set(["api", "browser", "mcp-oauth"]),
  // Sign in via Better Auth and carry the session BOTH ways: `credentials`
  // for surfaces that sign in themselves (api, mcp consent) and the session
  // `cookies` for the browser surface to inject into its context.
  newIdentity: () =>
    Effect.promise(async (): Promise<Identity> => {
      const response = await fetch(new URL("/api/auth/sign-in/email", SELFHOST_BASE_URL), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: new URL(SELFHOST_BASE_URL).origin,
        },
        body: JSON.stringify(SELFHOST_ADMIN),
        redirect: "manual",
      });
      const cookies = (response.headers.getSetCookie?.() ?? []).flatMap((cookie) => {
        const pair = cookie.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        if (eq <= 0) return [];
        return [{ name: pair.slice(0, eq), value: pair.slice(eq + 1) }];
      });
      if (cookies.length === 0) {
        throw new Error(`selfhost newIdentity: sign-in set no cookie (${response.status})`);
      }
      return {
        label: SELFHOST_ADMIN.email,
        credentials: SELFHOST_ADMIN,
        cookies,
      };
    }),
  mcpConsent: (identity: Identity) =>
    cookieConsentStrategy({
      appBaseUrl: SELFHOST_BASE_URL,
      email: identity.credentials?.email ?? SELFHOST_ADMIN.email,
      password: identity.credentials?.password ?? SELFHOST_ADMIN.password,
    }),
});

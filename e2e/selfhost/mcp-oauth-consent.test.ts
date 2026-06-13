// Selfhost (browser, recorded): the MCP OAuth authorization flow a connecting
// client triggers, from an already-signed-in user. The recording (video +
// trace + per-step screenshots) is the artifact.
//
// What it captures TODAY: there is NO approval/consent screen. An authenticated
// `/api/auth/mcp/authorize` issues an authorization code and redirects straight
// back to the client — `mcp({ loginPage: "/login" })` in
// apps/host-selfhost/src/auth/better-auth.ts wires up a login page but no
// consent page, so Better Auth auto-consents. A connecting MCP client is
// granted a token with no human approval step.
//
// When a consent screen IS added, this scenario is where it gets pinned: the
// authorize step should stop on an approval page, assert an Approve button,
// click it, THEN land on the redirect. Until then the assertion documents the
// current auto-consent behavior.
//
// (The flow is driven from a signed-in browser rather than typing into the
// login page because the consent gap — not the login UI — is the subject, and
// the login page does not cleanly resume the OAuth request after sign-in.)
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Browser, Target } from "../src/services";

interface AuthServerMetadata {
  readonly authorization_endpoint: string;
  readonly registration_endpoint: string;
}

scenario(
  "MCP OAuth · the browser authorize flow (records the missing approval step)",
  { timeout: 180_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const browser = yield* Browser;
    // A signed-in identity (the browser context is seeded with its session
    // cookies) — the subject is what an MCP client's authorize request does for
    // an already-authenticated user.
    const identity = yield* target.newIdentity();

    // Authorization-server discovery + dynamic client registration (what a real
    // MCP client does before it ever opens a browser). The redirect lands back
    // in the app so the recording ends on the authenticated console.
    const metadata = (yield* Effect.promise(() =>
      fetch(new URL("/.well-known/oauth-authorization-server", target.baseUrl)).then((r) =>
        r.json(),
      ),
    )) as AuthServerMetadata;

    const redirectUri = new URL("/", target.baseUrl).toString();
    const registered = (yield* Effect.promise(() =>
      fetch(metadata.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude (MCP) — demo",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }).then((r) => r.json()),
    )) as { readonly client_id: string };

    const verifier = randomBytes(32).toString("base64url");
    const authorizeUrl = new URL(metadata.authorization_endpoint);
    authorizeUrl.searchParams.set("client_id", registered.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", randomUUID());
    authorizeUrl.searchParams.set(
      "code_challenge",
      createHash("sha256").update(verifier).digest("base64url"),
    );
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const authorize = authorizeUrl.toString();

    yield* browser.session(identity, async ({ page, step }) => {
      await step("A signed-in user is using their Executor instance", async () => {
        await page.goto("/", { waitUntil: "networkidle" });
        // Confirm we're in the app, not bounced to sign-in.
        expect(new URL(page.url()).pathname, "the session is active (not on /login)").not.toBe(
          "/login",
        );
      });

      await step(
        "An MCP client requests authorization — watch for an approval prompt",
        async () => {
          // A connecting MCP client opens this authorize URL in the browser. If
          // an approval/consent screen existed, the browser would STOP here on a
          // page with an Approve button. Today it does not.
          await page.goto(authorize, { waitUntil: "networkidle" });

          const approve = page.getByRole("button", { name: /approve|authorize|allow|consent/i });
          expect(
            await approve.count(),
            "TODAY there is no approval screen — Better Auth auto-consents (this is the gap)",
          ).toBe(0);

          const landed = new URL(page.url());
          expect(
            landed.origin + landed.pathname,
            "the request redirected straight back to the client (no approval step)",
          ).toBe(redirectUri.replace(/\/$/, "") + "/");
          expect(
            landed.searchParams.get("code"),
            "an authorization code was granted with no human approval",
          ).toBeTruthy();
        },
      );
    });
  }),
);

// The OpenCode daily re-auth, reproduced with the REAL opencode
// binary in a REAL terminal. The whole session runs in one recorded PTY —
// the run's terminal.cast replays exactly what a user at a shell would see:
// authenticate, connected, wait out the token, suddenly "needs
// authentication" again.
//
// Nothing about the client is modeled: OpenCode runs its own discovery
// against our published metadata, its own DCR, its own scope selection, its
// own token storage. The only theater is the browser hop (an open(1) shim
// captures the URL and a fetch with login_hint plays the signed-in human)
// and time (the target's ttl-control compresses "a day" into seconds). The
// scenario asserts the experience a user deserves —
// authenticate once, stay signed in across an access-token expiry. It stays
// red until the server gives spec-faithful clients a way to refresh.
import { join } from "node:path";

import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { completeOAuthConsent, makeOpenCodeHome, warmUp } from "../src/clients/opencode";

const SERVER_NAME = "executor";
const TTL_SECONDS = 15;

scenario(
  "MCP OAuth lifecycle · the real OpenCode binary stays signed in across token expiry",
  { needs: ["mcp-oauth", "opencode", "ttl-control"], timeout: 180_000 },
  (ctx) =>
    Effect.gen(function* () {
      const setTtl = ctx.target.setAccessTokenTtl;
      if (!setTtl)
        return yield* Effect.die(new Error("ttl-control target lacks setAccessTokenTtl"));
      const identity = yield* ctx.target.newIdentity();
      const email = identity.credentials?.email ?? identity.label;
      const home = makeOpenCodeHome(SERVER_NAME, ctx.target.mcpUrl);
      // First-run database migration happens off camera.
      yield* Effect.sync(() => warmUp(home));

      yield* setTtl(TTL_SECONDS);
      yield* ctx.cli
        .session(
          ["bash", "--norc"],
          async (term) => {
            // Don't type into a shell that hasn't painted its prompt yet —
            // early keystrokes echo above the prompt in the recording.
            await term.screen.waitForText("$", { timeoutMs: 10_000 });

            // A command is done when its echoed line is on screen AND the
            // bare prompt is back after it — no sentinel noise, no clears,
            // and the pre-command prompt can't satisfy the wait. Returns
            // only what THIS command produced, so earlier output can't
            // satisfy a later assertion and the scrollback stays natural.
            const outputAfter = (text: string, line: string): string | null => {
              const echoed = text.lastIndexOf(line);
              if (echoed === -1) return null;
              const after = text.slice(echoed + line.length);
              return after.trimEnd().endsWith("\n$") ? after : null;
            };
            const sh = async (line: string, timeoutMs: number) => {
              await term.keyboard.type(line);
              await term.keyboard.press("Enter");
              const snapshot = await term.screen.waitUntil(
                (current) => outputAfter(current.text, line) !== null,
                { timeoutMs },
              );
              return outputAfter(snapshot.text, line) ?? "";
            };

            // OpenCode completes MCP OAuth for real: discovery, DCR, PKCE,
            // its own scope request, its own token store.
            const consent = completeOAuthConsent(home, email, home.openedUrls().length);
            const auth = await sh(`opencode mcp auth ${SERVER_NAME}`, 60_000);
            await consent;
            expect(auth, "opencode mcp auth completes").not.toContain("failed");

            // While the token is fresh, OpenCode is a working MCP client.
            const fresh = await sh("opencode mcp list", 60_000);
            expect(fresh, "OpenCode connects on a fresh token").toContain("connected");

            // The access token genuinely expires on camera (server-honored
            // TTL, no fakes), then the same command runs again.
            const expired = await sh(
              `sleep ${TTL_SECONDS + 3}; opencode mcp list`,
              (TTL_SECONDS + 3) * 1000 + 60_000,
            );

            // The experience a user deserves: still signed in. OpenCode
            // requested exactly the scopes our metadata advertises; whether
            // it got a refresh token decides this assertion — that's the bug.
            const tokens = home.storedTokens(SERVER_NAME);
            expect(
              expired,
              `OpenCode stays signed in across token expiry (its store holds ${
                tokens?.refreshToken ? "a refresh token" : "NO refresh token"
              })`,
            ).toContain("connected");
          },
          {
            cwd: home.projectDir,
            env: { ...home.env, PS1: "$ ", BASH_SILENCE_DEPRECATION_WARNING: "1" },
            record: join(ctx.dir, "terminal.cast"),
            // Tall enough that the whole session stays on screen — the
            // per-command slice in sh() depends on the echoed line not
            // scrolling away.
            viewport: { cols: 100, rows: 40 },
          },
        )
        .pipe(Effect.ensuring(setTtl(null)));
    }),
);

// ---------------------------------------------------------------------------
// scope-chain-prototype — scenarios
//
// Effect + @effect/vitest. Uses the real SDK's ScopeId / SecretId / error
// types so the prototype is exercising the same primitives the production
// SecretStore uses.
//
// Each test names a case from the design thread: Gmail-at-workspace,
// shared Slack bot, BYO OAuth client, headless agent, refresh-in-place,
// shadowing. If any of these feel wrong, the primitive is wrong.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { ScopeId, SecretId } from "../ids";
import { SecretNotFoundError, SecretResolutionError } from "../errors";

import {
  completeOAuth,
  makeChainSecretStore,
  makeChainSource,
  makeChainSourceRegistry,
  org,
  pickAuthLayer,
  platform,
  refreshInPlace,
  user,
  workspace,
  type Layer,
  type ScopeChain,
} from "./index";

// ---------- Fixtures -------------------------------------------------------

const PLATFORM = platform("platform", "Platform");
const ACME = org("org_acme", "Acme Inc");
const MARKETING = workspace("ws_marketing", "Marketing");
const ENGINEERING = workspace("ws_engineering", "Engineering");
const ALICE = user("user_alice", "Alice");
const BOB = user("user_bob", "Bob");

const chainFor = (...layers: readonly Layer[]): ScopeChain => layers;

const K = SecretId.make("k");
const OPENAI_KEY = SecretId.make("openai:key");
const GOOGLE_CLIENT_ID = SecretId.make("google:client_id");
const GOOGLE_CLIENT_SECRET = SecretId.make("google:client_secret");
const GMAIL_ACCESS = SecretId.make("gmail:access");
const SLACK_ACCESS = SecretId.make("slack:access");

const gmailAtMarketing = makeChainSource({
  id: "gmail",
  name: "Gmail",
  kind: "google",
  installedAt: MARKETING.id,
  authScope: { type: "kind", kind: "user" },
});

const slackBotAtMarketing = makeChainSource({
  id: "slack",
  name: "Slack",
  kind: "slack",
  installedAt: MARKETING.id,
  authScope: { type: "inherit" },
});

// ---------- Resolve cascade ------------------------------------------------

describe("resolve cascades narrowest → widest", () => {
  it.effect("returns the narrowest match", () =>
    Effect.gen(function* () {
      const secrets = makeChainSecretStore();
      yield* secrets.set({ name: K, scopeId: ACME.id, value: "org-value" });
      yield* secrets.set({ name: K, scopeId: MARKETING.id, value: "ws-value" });
      yield* secrets.set({ name: K, scopeId: ALICE.id, value: "alice-value" });

      const chain = chainFor(ALICE, MARKETING, ACME, PLATFORM);
      const r = yield* secrets.resolve(K, chain);
      expect(r.value).toBe("alice-value");
      expect(r.resolvedAt.id).toBe(ALICE.id);
    }),
  );

  it.effect("falls through to wider layers when narrower has no value", () =>
    Effect.gen(function* () {
      const secrets = makeChainSecretStore();
      yield* secrets.set({ name: K, scopeId: ACME.id, value: "org-value" });

      const chain = chainFor(ALICE, MARKETING, ACME);
      const r = yield* secrets.resolve(K, chain);
      expect(r.value).toBe("org-value");
      expect(r.resolvedAt.id).toBe(ACME.id);
    }),
  );

  it.effect("fails with SecretNotFoundError when no layer has it (clean miss)", () =>
    Effect.gen(function* () {
      const secrets = makeChainSecretStore();
      const chain = chainFor(ALICE, MARKETING, ACME);

      expect(yield* secrets.status(K, chain)).toBe("missing");

      const exit = yield* Effect.exit(secrets.resolve(K, chain));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = exit.cause._tag === "Fail" ? exit.cause.error : null;
        expect(err).toBeInstanceOf(SecretNotFoundError);
      }
    }),
  );

  it.effect("same name resolves differently for different users", () =>
    Effect.gen(function* () {
      const secrets = makeChainSecretStore();
      yield* secrets.set({ name: K, scopeId: ALICE.id, value: "alice" });
      yield* secrets.set({ name: K, scopeId: BOB.id, value: "bob" });

      expect((yield* secrets.resolve(K, chainFor(ALICE, MARKETING))).value).toBe("alice");
      expect((yield* secrets.resolve(K, chainFor(BOB, MARKETING))).value).toBe("bob");
    }),
  );
});

// ---------- Source merge ---------------------------------------------------

describe("source list merges with shadow-dedup", () => {
  it.effect("exposes sources from every layer in the chain", () =>
    Effect.gen(function* () {
      const sources = makeChainSourceRegistry();
      yield* sources.install(slackBotAtMarketing);
      yield* sources.install(
        makeChainSource({
          id: "stripe",
          name: "Stripe",
          kind: "openapi",
          installedAt: ACME.id,
          authScope: { type: "inherit" },
        }),
      );

      const chain = chainFor(ALICE, MARKETING, ACME);
      const list = yield* sources.list(chain);
      const ids = list.map((s) => s.id);
      expect(ids).toEqual(expect.arrayContaining(["slack", "stripe"]));
      expect(ids).toHaveLength(2);
    }),
  );

  it.effect("narrower layer shadows wider layer for same source id", () =>
    Effect.gen(function* () {
      const sources = makeChainSourceRegistry();
      yield* sources.install(
        makeChainSource({
          id: "github",
          name: "GitHub (org)",
          kind: "openapi",
          installedAt: ACME.id,
          authScope: { type: "inherit" },
        }),
      );
      yield* sources.install(
        makeChainSource({
          id: "github",
          name: "GitHub (alice)",
          kind: "openapi",
          installedAt: ALICE.id,
          authScope: { type: "inherit" },
        }),
      );

      const aliceChain = chainFor(ALICE, ACME);
      const bobChain = chainFor(BOB, ACME);

      expect((yield* sources.get("github", aliceChain))?.name).toBe("GitHub (alice)");
      expect((yield* sources.get("github", bobChain))?.name).toBe("GitHub (org)");
    }),
  );

  it.effect("hides sources installed at layers not in the chain", () =>
    Effect.gen(function* () {
      const sources = makeChainSourceRegistry();
      yield* sources.install(gmailAtMarketing);

      const engChain = chainFor(ALICE, ENGINEERING, ACME);
      expect(yield* sources.list(engChain)).toHaveLength(0);
    }),
  );
});

// ---------- pickAuthLayer --------------------------------------------------

describe("pickAuthLayer", () => {
  it("inherit → source's own layer", () => {
    const chain = chainFor(ALICE, MARKETING, ACME);
    expect(pickAuthLayer(slackBotAtMarketing, chain)?.id).toBe(MARKETING.id);
  });

  it("kind=user → narrowest user-kind layer in the chain", () => {
    const chain = chainFor(ALICE, MARKETING, ACME);
    expect(pickAuthLayer(gmailAtMarketing, chain)?.id).toBe(ALICE.id);
  });

  it("kind=user with no user layer → null (clean failure)", () => {
    const agentChain = chainFor(MARKETING, ACME, PLATFORM);
    expect(pickAuthLayer(gmailAtMarketing, agentChain)).toBeNull();
  });

  it("pinned → the named scope if in chain, else null", () => {
    const pinned = makeChainSource({
      ...gmailAtMarketing,
      installedAt: gmailAtMarketing.installedAt,
      authScope: { type: "pinned", scopeId: ACME.id },
    });
    expect(pickAuthLayer(pinned, chainFor(ALICE, MARKETING, ACME))?.id).toBe(ACME.id);
    expect(pickAuthLayer(pinned, chainFor(ALICE, MARKETING))).toBeNull();
  });
});

// ---------- Flagship: Gmail at workspace ----------------------------------

describe("Gmail at workspace, authScope user", () => {
  it.effect("Alice OAuths and her token lands at her user layer", () =>
    Effect.gen(function* () {
      const secrets = makeChainSecretStore();
      const sources = makeChainSourceRegistry();
      yield* sources.install(gmailAtMarketing);

      const aliceChain = chainFor(ALICE, MARKETING, ACME);

      // Source visible, no token yet
      const list = yield* sources.list(aliceChain);
      expect(list.map((s) => s.id)).toContain("gmail");
      expect(yield* secrets.status(GMAIL_ACCESS, aliceChain)).toBe("missing");

      // Alice completes OAuth
      const landed = yield* completeOAuth(
        secrets,
        gmailAtMarketing,
        aliceChain,
        { access: "alice-access-token", refresh: "alice-refresh-token" },
      );

      // Lands at ALICE, not MARKETING
      expect(landed.id).toBe(ALICE.id);
      expect(yield* secrets.status(GMAIL_ACCESS, aliceChain)).toBe("resolved");

      // Physically stored at user:alice, not the workspace
      const aliceSecrets = yield* secrets.listAtLayer(ALICE.id);
      const wsSecrets = yield* secrets.listAtLayer(MARKETING.id);
      expect(aliceSecrets).toContain(GMAIL_ACCESS);
      expect(wsSecrets).not.toContain(GMAIL_ACCESS);
    }),
  );

  it.effect("Bob sees the same source but no token until he signs in", () =>
    Effect.gen(function* () {
      const secrets = makeChainSecretStore();
      const sources = makeChainSourceRegistry();
      yield* sources.install(gmailAtMarketing);

      const aliceChain = chainFor(ALICE, MARKETING, ACME);
      const bobChain = chainFor(BOB, MARKETING, ACME);

      yield* completeOAuth(secrets, gmailAtMarketing, aliceChain, {
        access: "alice-tok",
      });

      // Alice resolves; Bob is missing
      expect((yield* secrets.resolve(GMAIL_ACCESS, aliceChain)).value).toBe("alice-tok");
      expect(yield* secrets.status(GMAIL_ACCESS, bobChain)).toBe("missing");

      // Bob signs in with his own account
      yield* completeOAuth(secrets, gmailAtMarketing, bobChain, {
        access: "bob-tok",
      });

      // Each resolves to their own token. No leakage.
      expect((yield* secrets.resolve(GMAIL_ACCESS, aliceChain)).value).toBe("alice-tok");
      expect((yield* secrets.resolve(GMAIL_ACCESS, bobChain)).value).toBe("bob-tok");
    }),
  );
});

// ---------- Shared workspace OAuth (Slack bot) ----------------------------

describe("Slack bot at workspace, authScope inherit", () => {
  it.effect("one person OAuths, everyone in the workspace resolves the same token", () =>
    Effect.gen(function* () {
      const secrets = makeChainSecretStore();
      const sources = makeChainSourceRegistry();
      yield* sources.install(slackBotAtMarketing);

      const aliceChain = chainFor(ALICE, MARKETING, ACME);
      const bobChain = chainFor(BOB, MARKETING, ACME);

      const landed = yield* completeOAuth(
        secrets,
        slackBotAtMarketing,
        aliceChain,
        { access: "xoxb-shared" },
      );
      expect(landed.id).toBe(MARKETING.id);

      expect((yield* secrets.resolve(SLACK_ACCESS, aliceChain)).value).toBe("xoxb-shared");
      expect((yield* secrets.resolve(SLACK_ACCESS, bobChain)).value).toBe("xoxb-shared");
      expect((yield* secrets.resolve(SLACK_ACCESS, aliceChain)).resolvedAt.id).toBe(
        MARKETING.id,
      );
    }),
  );
});

// ---------- BYO OAuth client credentials ----------------------------------

describe("BYO OAuth app: org override shadows platform default", () => {
  it.effect("client_id/client_secret resolve from platform until org overrides", () =>
    Effect.gen(function* () {
      const secrets = makeChainSecretStore();
      yield* secrets.set({
        name: GOOGLE_CLIENT_ID,
        scopeId: PLATFORM.id,
        value: "platform-client-id",
      });
      yield* secrets.set({
        name: GOOGLE_CLIENT_SECRET,
        scopeId: PLATFORM.id,
        value: "platform-client-secret",
      });

      const chain = chainFor(ALICE, MARKETING, ACME, PLATFORM);

      const beforeId = yield* secrets.resolve(GOOGLE_CLIENT_ID, chain);
      expect(beforeId.value).toBe("platform-client-id");
      expect(beforeId.resolvedAt.id).toBe(PLATFORM.id);

      // Acme writes its own at org scope — same name, different layer
      yield* secrets.set({
        name: GOOGLE_CLIENT_ID,
        scopeId: ACME.id,
        value: "acme-client-id",
      });
      yield* secrets.set({
        name: GOOGLE_CLIENT_SECRET,
        scopeId: ACME.id,
        value: "acme-client-secret",
      });

      // Same call site, different result. No handler code changes.
      const afterId = yield* secrets.resolve(GOOGLE_CLIENT_ID, chain);
      expect(afterId.value).toBe("acme-client-id");
      expect(afterId.resolvedAt.id).toBe(ACME.id);

      // Another org still sees the platform default
      const OTHER = org("org_other", "Other Inc");
      const otherChain = chainFor(ALICE, OTHER, PLATFORM);
      expect((yield* secrets.resolve(GOOGLE_CLIENT_ID, otherChain)).value).toBe(
        "platform-client-id",
      );
    }),
  );
});

// ---------- Headless agent -------------------------------------------------

describe("headless agent without a user layer", () => {
  it.effect("per-user source cleanly fails — no silent leakage", () =>
    Effect.gen(function* () {
      const secrets = makeChainSecretStore();
      const sources = makeChainSourceRegistry();
      yield* sources.install(gmailAtMarketing);

      // Alice has signed in in another session
      yield* completeOAuth(
        secrets,
        gmailAtMarketing,
        chainFor(ALICE, MARKETING, ACME),
        { access: "alice-tok" },
      );

      // Unattended agent — no user layer
      const agentChain = chainFor(MARKETING, ACME, PLATFORM);

      // Source is visible (installed at workspace)...
      expect((yield* sources.get("gmail", agentChain))?.id).toBe("gmail");

      // ...but resolve fails cleanly
      expect(yield* secrets.status(GMAIL_ACCESS, agentChain)).toBe("missing");
      const exit = yield* Effect.exit(secrets.resolve(GMAIL_ACCESS, agentChain));
      expect(Exit.isFailure(exit)).toBe(true);

      // And OAuth itself can't complete — no matching layer for authScope
      const oauthExit = yield* Effect.exit(
        completeOAuth(secrets, gmailAtMarketing, agentChain, { access: "nope" }),
      );
      expect(Exit.isFailure(oauthExit)).toBe(true);
      if (Exit.isFailure(oauthExit) && oauthExit.cause._tag === "Fail") {
        expect(oauthExit.cause.error).toBeInstanceOf(SecretResolutionError);
      }
    }),
  );

  it.effect("agent run as Alice (delegated) resolves her token", () =>
    Effect.gen(function* () {
      const secrets = makeChainSecretStore();
      const sources = makeChainSourceRegistry();
      yield* sources.install(gmailAtMarketing);

      const aliceChain = chainFor(ALICE, MARKETING, ACME);
      yield* completeOAuth(secrets, gmailAtMarketing, aliceChain, {
        access: "alice-tok",
      });

      // Agent invoked "as Alice" — her user layer is in the chain
      const delegated = chainFor(ALICE, MARKETING, ACME);
      expect((yield* secrets.resolve(GMAIL_ACCESS, delegated)).value).toBe("alice-tok");
    }),
  );
});

// ---------- Refresh in place ----------------------------------------------

describe("refresh-in-place writes back at resolvedAt", () => {
  it.effect("refresh rewrites at the layer the token was read from", () =>
    Effect.gen(function* () {
      const secrets = makeChainSecretStore();
      const sources = makeChainSourceRegistry();
      yield* sources.install(gmailAtMarketing);

      const aliceChain = chainFor(ALICE, MARKETING, ACME);
      yield* completeOAuth(secrets, gmailAtMarketing, aliceChain, {
        access: "stale-token",
        refresh: "r1",
      });

      const after = yield* refreshInPlace(
        secrets,
        gmailAtMarketing,
        aliceChain,
        () => "fresh-token",
      );

      expect(after.value).toBe("fresh-token");
      expect(after.resolvedAt.id).toBe(ALICE.id);

      // Not promoted up to the workspace
      const aliceSecrets = yield* secrets.listAtLayer(ALICE.id);
      const wsSecrets = yield* secrets.listAtLayer(MARKETING.id);
      expect(aliceSecrets).toContain(GMAIL_ACCESS);
      expect(wsSecrets).not.toContain(GMAIL_ACCESS);
    }),
  );

  it.effect("refresh of a shared workspace token stays at the workspace", () =>
    Effect.gen(function* () {
      const secrets = makeChainSecretStore();
      const sources = makeChainSourceRegistry();
      yield* sources.install(slackBotAtMarketing);

      const aliceChain = chainFor(ALICE, MARKETING, ACME);
      yield* completeOAuth(secrets, slackBotAtMarketing, aliceChain, {
        access: "stale",
      });

      // Bob's session triggers the refresh
      const bobChain = chainFor(BOB, MARKETING, ACME);
      const after = yield* refreshInPlace(
        secrets,
        slackBotAtMarketing,
        bobChain,
        () => "fresh",
      );

      // Still lands at workspace, not Bob
      expect(after.resolvedAt.id).toBe(MARKETING.id);
      const wsSecrets = yield* secrets.listAtLayer(MARKETING.id);
      const bobSecrets = yield* secrets.listAtLayer(BOB.id);
      expect(wsSecrets).toContain(SLACK_ACCESS);
      expect(bobSecrets).not.toContain(SLACK_ACCESS);
    }),
  );
});

// ---------- User-composed chain -------------------------------------------

describe("user-composed chain: personal account prepended", () => {
  it.effect("Alice's personal secrets shadow workspace secrets when opted in", () =>
    Effect.gen(function* () {
      const secrets = makeChainSecretStore();
      const ALICE_PERSONAL = user("user_alice_personal", "Alice (personal)");

      yield* secrets.set({
        name: OPENAI_KEY,
        scopeId: MARKETING.id,
        value: "sk-team",
      });
      yield* secrets.set({
        name: OPENAI_KEY,
        scopeId: ALICE_PERSONAL.id,
        value: "sk-alice",
      });

      // Default chain: no personal layer → team key
      const defaultChain = chainFor(ALICE, MARKETING, ACME);
      expect((yield* secrets.resolve(OPENAI_KEY, defaultChain)).value).toBe("sk-team");

      // Alice prepends her personal layer — explicit opt-in
      const composed = chainFor(ALICE_PERSONAL, ALICE, MARKETING, ACME);
      expect((yield* secrets.resolve(OPENAI_KEY, composed)).value).toBe("sk-alice");
    }),
  );
});

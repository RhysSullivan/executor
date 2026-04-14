// ---------------------------------------------------------------------------
// Fidelity tests for the OAuth popup HTML generator + callback wrapper.
// Locks in the escaping rules, postMessage/BroadcastChannel behavior, and
// the completeOAuth-to-popup-payload conversion semantics so the google-
// discovery port is provably behavior-preserving.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  OAUTH_POPUP_MESSAGE_TYPE,
  popupDocument,
  runOAuthCallback,
  type OAuthPopupResult,
} from "./http";

type GoogleAuth = {
  kind: "oauth2";
  accessTokenSecretId: string;
  refreshTokenSecretId: string | null;
};

// ---------------------------------------------------------------------------
// popupDocument
// ---------------------------------------------------------------------------

describe("popupDocument", () => {
  const successPayload: OAuthPopupResult<GoogleAuth> = {
    type: OAUTH_POPUP_MESSAGE_TYPE,
    ok: true,
    sessionId: "session-abc",
    kind: "oauth2",
    accessTokenSecretId: "secret_1",
    refreshTokenSecretId: "secret_2",
  };

  it("renders a success page with Connected title and the green check icon", () => {
    const html = popupDocument(successPayload, "channel-x");
    expect(html).toContain("<title>Connected</title>");
    expect(html).toContain("#22c55e");
    expect(html).toContain("Authentication complete");
  });

  it("renders a failure page with the error text escaped", () => {
    const html = popupDocument(
      {
        type: OAUTH_POPUP_MESSAGE_TYPE,
        ok: false,
        sessionId: null,
        error: "Token endpoint returned 400 <script>alert(1)</script>",
      },
      "channel-x",
    );
    expect(html).toContain("<title>Connection failed</title>");
    expect(html).toContain("#ef4444");
    expect(html).toContain("Token endpoint returned 400 &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("HTML-escapes the BroadcastChannel name so attacker-controlled names cannot break out", () => {
    const html = popupDocument(successPayload, 'evil"name');
    expect(html).toContain('new BroadcastChannel("evil&quot;name")');
  });

  it("escapes < > & in the serialized script payload to prevent </script> breakout", () => {
    const html = popupDocument(
      {
        type: OAUTH_POPUP_MESSAGE_TYPE,
        ok: false,
        sessionId: null,
        error: "</script><img/src=x onerror=alert(1)>",
      },
      "channel-x",
    );
    // The raw `</script>` must not appear in the inline script literal.
    const scriptLiteralMatch = /const p=(\{.*?\});/.exec(html);
    expect(scriptLiteralMatch).not.toBeNull();
    const scriptLiteral = scriptLiteralMatch![1]!;
    expect(scriptLiteral).not.toContain("</script>");
    expect(scriptLiteral).toContain("\\u003c/script\\u003e");
  });

  it("posts to window.opener AND falls back to BroadcastChannel with the given channel name", () => {
    const html = popupDocument(successPayload, "executor:openapi-oauth-result");
    expect(html).toContain("window.opener.postMessage(p,window.location.origin)");
    expect(html).toContain('new BroadcastChannel("executor:openapi-oauth-result")');
    expect(html).toContain("window.close()");
  });

  it("includes dark-mode CSS", () => {
    const html = popupDocument(successPayload, "c");
    expect(html).toContain("@media(prefers-color-scheme:dark)");
  });
});

// ---------------------------------------------------------------------------
// runOAuthCallback
// ---------------------------------------------------------------------------

describe("runOAuthCallback", () => {
  it("renders a success popup when completeOAuth succeeds", async () => {
    const html = await Effect.runPromise(
      runOAuthCallback<GoogleAuth, never, never>({
        complete: () =>
          Effect.succeed({
            kind: "oauth2",
            accessTokenSecretId: "s1",
            refreshTokenSecretId: "s2",
          }),
        urlParams: { state: "session-xyz", code: "abc" },
        toErrorMessage: () => "should not reach",
        channelName: "channel-x",
      }),
    );
    expect(html).toContain("<title>Connected</title>");
    expect(html).toContain("session-xyz");
    expect(html).toContain("s1");
  });

  it("passes code and error through to the complete callback verbatim", async () => {
    const received: Array<{ state: string; code: string | null; error: string | null }> = [];
    await Effect.runPromise(
      runOAuthCallback<GoogleAuth, never, never>({
        complete: (params) => {
          received.push(params);
          return Effect.succeed({
            kind: "oauth2",
            accessTokenSecretId: "s",
            refreshTokenSecretId: null,
          });
        },
        urlParams: { state: "s1", code: "code1", error: null },
        toErrorMessage: () => "",
        channelName: "c",
      }),
    );
    expect(received).toEqual([{ state: "s1", code: "code1", error: null }]);
  });

  it("prefers `error` over `error_description` but falls back when absent", async () => {
    const received: Array<{ state: string; code: string | null; error: string | null }> = [];
    const complete = (params: { state: string; code: string | null; error: string | null }) => {
      received.push(params);
      return Effect.succeed({
        kind: "oauth2" as const,
        accessTokenSecretId: "s",
        refreshTokenSecretId: null,
      });
    };
    await Effect.runPromise(
      runOAuthCallback<GoogleAuth, never, never>({
        complete,
        urlParams: { state: "s1", error: "access_denied" },
        toErrorMessage: () => "",
        channelName: "c",
      }),
    );
    await Effect.runPromise(
      runOAuthCallback<GoogleAuth, never, never>({
        complete,
        urlParams: { state: "s2", error_description: "user cancelled" },
        toErrorMessage: () => "",
        channelName: "c",
      }),
    );
    expect(received[0]!.error).toBe("access_denied");
    expect(received[1]!.error).toBe("user cancelled");
  });

  it("renders a failure popup when completeOAuth fails and uses toErrorMessage", async () => {
    class DomainError {
      readonly _tag = "DomainError";
      constructor(readonly message: string) {}
    }
    const html = await Effect.runPromise(
      runOAuthCallback<GoogleAuth, DomainError, never>({
        complete: () => Effect.fail(new DomainError("Code expired")),
        urlParams: { state: "s1" },
        toErrorMessage: (error) =>
          error instanceof DomainError ? error.message : "unknown",
        channelName: "c",
      }),
    );
    expect(html).toContain("<title>Connection failed</title>");
    expect(html).toContain("Code expired");
  });

  it("never rejects — even defects are rendered as a failure popup", async () => {
    const html = await Effect.runPromise(
      runOAuthCallback<GoogleAuth, never, never>({
        complete: () => Effect.die("boom"),
        urlParams: { state: "s1" },
        toErrorMessage: () => "transport error",
        channelName: "c",
      }),
    );
    expect(html).toContain("<title>Connection failed</title>");
    expect(html).toContain("transport error");
  });
});

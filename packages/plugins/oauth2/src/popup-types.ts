// ---------------------------------------------------------------------------
// OAuth popup result — the message shape exchanged between the popup window
// (opened during authorization) and the opener (the onboarding UI). Both the
// server-side HTML generator and the client-side popup opener agree on this
// shape so that success / failure can be communicated reliably via both
// `postMessage` and `BroadcastChannel`.
// ---------------------------------------------------------------------------

/** Message type literal used to identify our popup results. */
export const OAUTH_POPUP_MESSAGE_TYPE = "executor:oauth-result" as const;

export type OAuthPopupResult<TAuth> =
  | ({
      readonly type: typeof OAUTH_POPUP_MESSAGE_TYPE;
      readonly ok: true;
      readonly sessionId: string;
    } & TAuth)
  | {
      readonly type: typeof OAUTH_POPUP_MESSAGE_TYPE;
      readonly ok: false;
      readonly sessionId: null;
      readonly error: string;
    };

export const isOAuthPopupResult = <TAuth>(
  value: unknown,
): value is OAuthPopupResult<TAuth> =>
  typeof value === "object" &&
  value !== null &&
  (value as { type?: unknown }).type === OAUTH_POPUP_MESSAGE_TYPE;

// ---------------------------------------------------------------------------
// @executor/plugin-oauth2/react — browser popup opener for OAuth flows.
//
// Opens a centered popup window pointed at an authorization URL, listens
// for the result via `postMessage` and `BroadcastChannel` (Safari fallback),
// and settles exactly once. Has NO React-specific imports so it can be used
// from any browser context, but lives under the `/react` entry to signal
// it is browser-only and should not be imported from Node / worker code.
// ---------------------------------------------------------------------------

import {
  isOAuthPopupResult as sharedIsOAuthPopupResult,
  type OAuthPopupResult,
} from "./popup-types";

export { OAUTH_POPUP_MESSAGE_TYPE } from "./popup-types";
export type { OAuthPopupResult } from "./popup-types";

export const isOAuthPopupResult = sharedIsOAuthPopupResult;

// ---------------------------------------------------------------------------
// openOAuthPopup
// ---------------------------------------------------------------------------

export type OpenOAuthPopupInput<TAuth> = {
  readonly url: string;
  readonly onResult: (data: OAuthPopupResult<TAuth>) => void;
  /** `window.open` target name — also used to focus an existing popup. */
  readonly popupName: string;
  /** BroadcastChannel name, must match the server-side `popupDocument` channel. */
  readonly channelName: string;
  readonly onOpenFailed?: () => void;
  /**
   * Called if the user closes the popup window without completing the
   * flow (detected via a `popup.closed` poll). NOT called when the popup
   * closes itself after a successful result post — `onResult` handles
   * that path. Also not called if the caller invokes the teardown
   * function returned from this function.
   */
  readonly onClosed?: () => void;
  readonly width?: number;
  readonly height?: number;
  /** How often to poll `popup.closed`. Default 500ms. */
  readonly closedPollMs?: number;
};

/**
 * Open a centered popup window at `url` and resolve when the popup posts
 * an `OAuthPopupResult` back to the opener. Returns a teardown function
 * that removes the listeners, stops polling, and closes the popup window.
 *
 * Settles exactly once via one of three paths:
 *   1. `onResult`      — popup posted a message back (success or error)
 *   2. `onClosed`      — user closed the popup without completing the flow
 *   3. teardown called — caller cancelled programmatically
 *
 * If the popup is blocked (`window.open` returns null), invokes
 * `onOpenFailed` on the next microtask and returns a no-op teardown.
 */
export const openOAuthPopup = <TAuth>(input: OpenOAuthPopupInput<TAuth>): (() => void) => {
  const w = input.width ?? 640;
  const h = input.height ?? 760;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;

  let settled = false;
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  const channel =
    typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(input.channelName) : null;

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    handleResult(event.data);
  };

  const stopPolling = () => {
    if (pollHandle !== null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  };

  /** Close the popup window if it's still open. Swallows cross-origin errors. */
  const closePopup = (popup: Window | null) => {
    if (!popup) return;
    try {
      if (!popup.closed) popup.close();
    } catch {
      // Cross-origin access can throw; safe to ignore.
    }
  };

  const settle = () => {
    if (settled) return;
    settled = true;
    window.removeEventListener("message", onMessage);
    channel?.close();
    stopPolling();
  };

  const handleResult = (data: unknown) => {
    if (!isOAuthPopupResult<TAuth>(data) || settled) return;
    settle();
    input.onResult(data);
  };

  window.addEventListener("message", onMessage);
  if (channel) channel.onmessage = (event) => handleResult(event.data);

  const popup = window.open(
    input.url,
    input.popupName,
    `width=${w},height=${h},left=${left},top=${top},popup=1`,
  );
  if (!popup) {
    if (!settled) {
      settle();
      queueMicrotask(() => input.onOpenFailed?.());
    }
    return () => {};
  }

  // Poll for manual popup close. We only settle via onClosed if no
  // message-based result has arrived; onResult settles first and
  // stops the poll before we see the close.
  const pollMs = input.closedPollMs ?? 500;
  pollHandle = setInterval(() => {
    let isClosed = false;
    try {
      isClosed = popup.closed;
    } catch {
      // Cross-origin access can throw during navigation; treat as open.
    }
    if (isClosed && !settled) {
      settle();
      input.onClosed?.();
    }
  }, pollMs);

  return () => {
    if (settled) return;
    settle();
    closePopup(popup);
  };
};

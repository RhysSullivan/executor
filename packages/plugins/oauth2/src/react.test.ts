// ---------------------------------------------------------------------------
// openOAuthPopup fidelity tests. Simulates the browser environment by
// stubbing window.open / postMessage / BroadcastChannel so we can lock in
// the settle-once semantics, origin checking, and popup-blocked handling
// without a real DOM.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OAUTH_POPUP_MESSAGE_TYPE,
  openOAuthPopup,
  type OAuthPopupResult,
} from "./react";

type TestAuth = { accessToken: string };

type MockPopup = { closed: boolean; close: () => void };

const originalWindow = (globalThis as { window?: unknown }).window;
const originalBroadcastChannel = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;

type MockChannel = {
  name: string;
  onmessage: ((event: { data: unknown }) => void) | null;
  close: () => void;
  closed: boolean;
};

const channels: MockChannel[] = [];

class FakeBroadcastChannel {
  name: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(name: string) {
    this.name = name;
    channels.push(this as unknown as MockChannel);
  }
  close() {
    this.closed = true;
  }
}

type WindowListener = (event: { origin: string; data: unknown }) => void;

type FakeWindow = {
  location: { origin: string };
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  open: (url: string, name: string, features?: string) => MockPopup | null;
  addEventListener: (type: string, cb: WindowListener) => void;
  removeEventListener: (type: string, cb: WindowListener) => void;
  messageListeners: Set<WindowListener>;
  _openCalls: Array<{ url: string; name: string; features?: string }>;
  _popupBlocked: boolean;
  _popups: MockPopup[];
};

const makeFakeWindow = (): FakeWindow => {
  const messageListeners = new Set<WindowListener>();
  const openCalls: FakeWindow["_openCalls"] = [];
  const popups: MockPopup[] = [];
  return {
    location: { origin: "https://app.example.com" },
    screenX: 0,
    screenY: 0,
    outerWidth: 1280,
    outerHeight: 900,
    open: (url, name, features) => {
      openCalls.push({ url, name, features });
      if (fakeWindow._popupBlocked) return null;
      const popup: MockPopup = {
        closed: false,
        close() {
          popup.closed = true;
        },
      };
      popups.push(popup);
      return popup;
    },
    addEventListener: (type, cb) => {
      if (type === "message") messageListeners.add(cb);
    },
    removeEventListener: (type, cb) => {
      if (type === "message") messageListeners.delete(cb);
    },
    messageListeners,
    _openCalls: openCalls,
    _popupBlocked: false,
    _popups: popups,
  };
};

let fakeWindow: FakeWindow;

beforeEach(() => {
  fakeWindow = makeFakeWindow();
  (globalThis as { window?: unknown }).window = fakeWindow;
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel;
  channels.length = 0;
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = originalBroadcastChannel;
});

const successMessage = (auth: TestAuth): OAuthPopupResult<TestAuth> => ({
  type: OAUTH_POPUP_MESSAGE_TYPE,
  ok: true,
  sessionId: "session-1",
  ...auth,
});

describe("openOAuthPopup", () => {
  it("opens a centered popup at the given url with the given name", () => {
    openOAuthPopup<TestAuth>({
      url: "https://auth.example.com/authorize?x=1",
      onResult: () => {},
      popupName: "my-oauth-popup",
      channelName: "my-channel",
    });
    expect(fakeWindow._openCalls).toHaveLength(1);
    const call = fakeWindow._openCalls[0]!;
    expect(call.url).toBe("https://auth.example.com/authorize?x=1");
    expect(call.name).toBe("my-oauth-popup");
    expect(call.features).toContain("width=640");
    expect(call.features).toContain("height=760");
    expect(call.features).toContain("popup=1");
  });

  it("resolves via window.message event and only accepts same-origin messages", () => {
    const results: Array<OAuthPopupResult<TestAuth>> = [];
    openOAuthPopup<TestAuth>({
      url: "https://auth.example.com/authorize",
      onResult: (data) => results.push(data),
      popupName: "p",
      channelName: "c",
    });

    // Cross-origin message should be ignored.
    for (const listener of fakeWindow.messageListeners) {
      listener({ origin: "https://evil.example.com", data: successMessage({ accessToken: "nope" }) });
    }
    expect(results).toHaveLength(0);

    // Same-origin message resolves.
    for (const listener of fakeWindow.messageListeners) {
      listener({ origin: "https://app.example.com", data: successMessage({ accessToken: "tok" }) });
    }
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(true);
  });

  it("resolves via BroadcastChannel when postMessage does not reach the opener", () => {
    const results: Array<OAuthPopupResult<TestAuth>> = [];
    openOAuthPopup<TestAuth>({
      url: "https://auth.example.com/authorize",
      onResult: (data) => results.push(data),
      popupName: "p",
      channelName: "c",
    });
    expect(channels).toHaveLength(1);
    channels[0]!.onmessage?.({ data: successMessage({ accessToken: "tok" }) });
    expect(results).toHaveLength(1);
  });

  it("settles exactly once even if both channels deliver a result", () => {
    const results: Array<OAuthPopupResult<TestAuth>> = [];
    openOAuthPopup<TestAuth>({
      url: "https://auth.example.com/authorize",
      onResult: (data) => results.push(data),
      popupName: "p",
      channelName: "c",
    });
    // Deliver via BroadcastChannel first.
    channels[0]!.onmessage?.({ data: successMessage({ accessToken: "one" }) });
    // Then via postMessage.
    for (const listener of fakeWindow.messageListeners) {
      listener({ origin: "https://app.example.com", data: successMessage({ accessToken: "two" }) });
    }
    expect(results).toHaveLength(1);
  });

  it("ignores messages that don't match the OAuthPopupResult shape", () => {
    const results: Array<OAuthPopupResult<TestAuth>> = [];
    openOAuthPopup<TestAuth>({
      url: "https://auth.example.com/authorize",
      onResult: (data) => results.push(data),
      popupName: "p",
      channelName: "c",
    });
    for (const listener of fakeWindow.messageListeners) {
      listener({ origin: "https://app.example.com", data: { type: "other", ok: true } });
    }
    expect(results).toHaveLength(0);
  });

  it("closes the BroadcastChannel and removes the listener when settled", () => {
    openOAuthPopup<TestAuth>({
      url: "https://auth.example.com/authorize",
      onResult: () => {},
      popupName: "p",
      channelName: "c",
    });
    for (const listener of fakeWindow.messageListeners) {
      listener({ origin: "https://app.example.com", data: successMessage({ accessToken: "tok" }) });
    }
    expect(fakeWindow.messageListeners.size).toBe(0);
    expect(channels[0]!.closed).toBe(true);
  });

  it("invokes onOpenFailed when the browser blocks the popup", async () => {
    fakeWindow._popupBlocked = true;
    const onOpenFailed = vi.fn();
    openOAuthPopup<TestAuth>({
      url: "https://auth.example.com/authorize",
      onResult: () => {},
      popupName: "p",
      channelName: "c",
      onOpenFailed,
    });
    // queueMicrotask is still a microtask — await a resolved promise to flush.
    await Promise.resolve();
    expect(onOpenFailed).toHaveBeenCalledOnce();
  });

  it("teardown function is idempotent", () => {
    const teardown = openOAuthPopup<TestAuth>({
      url: "https://auth.example.com/authorize",
      onResult: () => {},
      popupName: "p",
      channelName: "c",
    });
    teardown();
    teardown();
    expect(fakeWindow.messageListeners.size).toBe(0);
    expect(channels[0]!.closed).toBe(true);
  });

  it("accepts a custom width and height", () => {
    openOAuthPopup<TestAuth>({
      url: "https://auth.example.com/authorize",
      onResult: () => {},
      popupName: "p",
      channelName: "c",
      width: 500,
      height: 500,
    });
    const call = fakeWindow._openCalls[0]!;
    expect(call.features).toContain("width=500");
    expect(call.features).toContain("height=500");
  });

  describe("close detection", () => {
    beforeAll(() => {
      vi.useFakeTimers();
    });
    afterAll(() => {
      vi.useRealTimers();
    });

    it("fires onClosed when the user manually closes the popup without delivering a result", () => {
      const onResult = vi.fn();
      const onClosed = vi.fn();
      openOAuthPopup<TestAuth>({
        url: "https://auth.example.com/authorize",
        onResult,
        popupName: "p",
        channelName: "c",
        onClosed,
        closedPollMs: 100,
      });
      expect(fakeWindow._popups).toHaveLength(1);
      // Simulate the user closing the popup.
      fakeWindow._popups[0]!.closed = true;
      vi.advanceTimersByTime(150);
      expect(onClosed).toHaveBeenCalledOnce();
      expect(onResult).not.toHaveBeenCalled();
    });

    it("does NOT fire onClosed when the popup closes as a side effect of delivering a result", () => {
      const onResult = vi.fn();
      const onClosed = vi.fn();
      openOAuthPopup<TestAuth>({
        url: "https://auth.example.com/authorize",
        onResult,
        popupName: "p",
        channelName: "c",
        onClosed,
        closedPollMs: 100,
      });
      for (const listener of fakeWindow.messageListeners) {
        listener({
          origin: "https://app.example.com",
          data: successMessage({ accessToken: "tok" }),
        });
      }
      expect(onResult).toHaveBeenCalledOnce();
      // The popup will close itself after posting; advance the timer and
      // verify we do NOT fire onClosed redundantly.
      fakeWindow._popups[0]!.closed = true;
      vi.advanceTimersByTime(500);
      expect(onClosed).not.toHaveBeenCalled();
    });

    it("stops polling once the teardown function is invoked", () => {
      const onClosed = vi.fn();
      const teardown = openOAuthPopup<TestAuth>({
        url: "https://auth.example.com/authorize",
        onResult: () => {},
        popupName: "p",
        channelName: "c",
        onClosed,
        closedPollMs: 100,
      });
      teardown();
      // Simulate the popup being closed after teardown — onClosed must not fire.
      fakeWindow._popups[0]!.closed = true;
      vi.advanceTimersByTime(500);
      expect(onClosed).not.toHaveBeenCalled();
    });

    it("teardown closes the popup window if it's still open", () => {
      const teardown = openOAuthPopup<TestAuth>({
        url: "https://auth.example.com/authorize",
        onResult: () => {},
        popupName: "p",
        channelName: "c",
      });
      expect(fakeWindow._popups[0]!.closed).toBe(false);
      teardown();
      expect(fakeWindow._popups[0]!.closed).toBe(true);
    });
  });
});

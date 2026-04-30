import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet } from "@effect-atom/atom-react";

import { cancelOAuth, startOAuth } from "../api/atoms";
import { openOAuthPopup, type OAuthPopupResult } from "../api/oauth-popup";
import { useScope } from "../api/scope-context";
import { OAUTH_POPUP_MESSAGE_TYPE, type OAuthStrategy } from "@executor/sdk";

type SecretBackedValue =
  | string
  | {
      readonly secretId: string;
      readonly prefix?: string;
    };

export type OAuthCompletionPayload = {
  readonly connectionId: string;
  readonly expiresAt: number | null;
  readonly scope: string | null;
};

export type OAuthStartPayload = {
  readonly endpoint: string;
  readonly headers?: Record<string, SecretBackedValue>;
  readonly queryParams?: Record<string, SecretBackedValue>;
  readonly redirectUrl?: string;
  readonly connectionId: string;
  readonly tokenScope?: string;
  readonly strategy: OAuthStrategy;
  readonly pluginId: string;
  readonly identityLabel?: string;
};

export type StartOAuthPopupInput<TPayload extends OAuthCompletionPayload> = {
  readonly payload: OAuthStartPayload;
  readonly onSuccess: (payload: TPayload) => void | Promise<void>;
  readonly onError?: (error: string) => void;
  readonly onAuthorizationStarted?: (result: OAuthAuthorizationStartResult) => void;
};

export type OAuthAuthorizationStartResult = {
  readonly sessionId: string;
  readonly authorizationUrl: string | null;
};

export type StartOAuthAuthorizationInput<TPayload extends OAuthCompletionPayload> = {
  readonly run: () => Promise<OAuthAuthorizationStartResult>;
  readonly onSuccess: (payload: TPayload) => void | Promise<void>;
  readonly onError?: (error: string) => void;
  readonly onAuthorizationStarted?: (result: OAuthAuthorizationStartResult) => void;
};

export function oauthCallbackUrl(path = "/api/oauth/callback"): string {
  return typeof window === "undefined" ? path : `${window.location.origin}${path}`;
}

export function oauthConnectionId(input: {
  readonly pluginId: string;
  readonly namespace: string;
  readonly fallback?: string;
}): string {
  const namespace = input.namespace || input.fallback || "default";
  return `${input.pluginId}-oauth2-${namespace}`;
}

export function useOAuthPopupFlow<
  TPayload extends OAuthCompletionPayload = OAuthCompletionPayload,
>(options: {
  readonly popupName: string;
  readonly callbackPath?: string;
  readonly noAuthorizationUrlMessage?: string;
  readonly popupBlockedMessage?: string;
  readonly popupClosedMessage?: string;
  readonly startErrorMessage?: string;
}) {
  const {
    callbackPath,
    noAuthorizationUrlMessage,
    popupBlockedMessage,
    popupClosedMessage,
    popupName,
    startErrorMessage,
  } = options;
  const scopeId = useScope();
  const doStartOAuth = useAtomSet(startOAuth, { mode: "promise" });
  const doCancelOAuth = useAtomSet(cancelOAuth, { mode: "promise" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<string | null>(null);

  const cancelSession = useCallback(
    (sessionId: string) => {
      void doCancelOAuth({
        path: { scopeId },
        payload: { sessionId },
      }).catch(() => undefined);
    },
    [doCancelOAuth, scopeId],
  );

  const cancel = useCallback(() => {
    const sessionId = sessionRef.current;
    cleanupRef.current?.();
    cleanupRef.current = null;
    sessionRef.current = null;
    if (sessionId) cancelSession(sessionId);
    setBusy(false);
  }, [cancelSession]);

  useEffect(
    () => () => {
      const sessionId = sessionRef.current;
      cleanupRef.current?.();
      cleanupRef.current = null;
      sessionRef.current = null;
      if (sessionId) cancelSession(sessionId);
    },
    [cancelSession],
  );

  const openAuthorization = useCallback(
    async (input: StartOAuthAuthorizationInput<TPayload>) => {
      cancel();
      setBusy(true);
      setError(null);
      try {
        const response = await input.run();
        if (response.authorizationUrl === null) {
          const message =
            noAuthorizationUrlMessage ?? "OAuth start did not produce an authorization URL";
          setBusy(false);
          setError(message);
          input.onError?.(message);
          return;
        }

        sessionRef.current = response.sessionId;
        input.onAuthorizationStarted?.(response);
        cleanupRef.current = openOAuthPopup<TPayload>({
          url: response.authorizationUrl,
          popupName,
          channelName: OAUTH_POPUP_MESSAGE_TYPE,
          expectedSessionId: response.sessionId,
          onResult: async (result: OAuthPopupResult<TPayload>) => {
            cleanupRef.current = null;
            sessionRef.current = null;

            if (!result.ok) {
              setBusy(false);
              setError(result.error);
              input.onError?.(result.error);
              return;
            }

            try {
              await input.onSuccess(result);
              setBusy(false);
            } catch (e) {
              const message = e instanceof Error ? e.message : "Failed to persist new connection";
              setBusy(false);
              setError(message);
              input.onError?.(message);
            }
          },
          onClosed: () => {
            cleanupRef.current = null;
            sessionRef.current = null;
            cancelSession(response.sessionId);
            const message =
              popupClosedMessage ??
              "Sign-in cancelled - popup was closed before completing the flow.";
            setBusy(false);
            setError(message);
            input.onError?.(message);
          },
          onOpenFailed: () => {
            cleanupRef.current = null;
            sessionRef.current = null;
            cancelSession(response.sessionId);
            const message = popupBlockedMessage ?? "Sign-in popup was blocked by the browser";
            setBusy(false);
            setError(message);
            input.onError?.(message);
          },
        });
      } catch (e) {
        const message =
          e instanceof Error ? e.message : (startErrorMessage ?? "Failed to start sign-in");
        setBusy(false);
        setError(message);
        input.onError?.(message);
      }
    },
    [
      cancel,
      cancelSession,
      noAuthorizationUrlMessage,
      popupBlockedMessage,
      popupClosedMessage,
      popupName,
      startErrorMessage,
    ],
  );

  const start = useCallback(
    async (input: StartOAuthPopupInput<TPayload>) => {
      await openAuthorization({
        onSuccess: input.onSuccess,
        onError: input.onError,
        onAuthorizationStarted: input.onAuthorizationStarted,
        run: () =>
          doStartOAuth({
            path: { scopeId },
            payload: {
              ...input.payload,
              redirectUrl: input.payload.redirectUrl ?? oauthCallbackUrl(callbackPath),
            },
          }),
      });
    },
    [callbackPath, doStartOAuth, openAuthorization, scopeId],
  );

  return {
    busy,
    error,
    setError,
    start,
    openAuthorization,
    cancel,
  };
}

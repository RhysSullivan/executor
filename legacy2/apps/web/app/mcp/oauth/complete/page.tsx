"use client";

import { useEffect, useRef, useState } from "react";

type PopupMessage =
  | {
      type: "executor-v2:mcp-oauth-result";
      ok: true;
      sourceUrl: string;
      payload: {
        accessToken: string;
        refreshToken?: string;
        scope?: string;
        expiresIn?: number;
        clientId?: string;
        clientInformationJson?: string;
      };
    }
  | {
      type: "executor-v2:mcp-oauth-result";
      ok: false;
      error: string;
    };

const fallbackErrorMessage = (error: unknown): PopupMessage => ({
  type: "executor-v2:mcp-oauth-result",
  ok: false,
  error: error instanceof Error ? error.message : "Failed to finalize OAuth",
});

const fetchPopupResult = async (): Promise<PopupMessage> => {
  const response = await fetch("/mcp/oauth/result", {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
  });

  const data = (await response.json()) as PopupMessage;
  if (!data || data.type !== "executor-v2:mcp-oauth-result") {
    throw new Error("Invalid OAuth completion payload");
  }

  return data;
};

export default function McpOAuthCompletePage() {
  const sentRef = useRef(false);
  const [statusText, setStatusText] = useState("Finishing OAuth");

  useEffect(() => {
    if (sentRef.current) {
      return;
    }

    sentRef.current = true;

    void fetchPopupResult()
      .then((message) => {
        setStatusText("OAuth complete");

        if (window.opener) {
          window.opener.postMessage(message, window.location.origin);
        }
      })
      .catch((error) => {
        const message = fallbackErrorMessage(error);
        setStatusText("OAuth failed");

        if (window.opener) {
          window.opener.postMessage(message, window.location.origin);
        }
      })
      .finally(() => {
        window.close();
      });
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="text-center space-y-2">
        <h1 className="text-base font-medium">{statusText}</h1>
        <p className="text-sm text-muted-foreground">
          You can close this window if it does not close automatically.
        </p>
      </div>
    </main>
  );
}

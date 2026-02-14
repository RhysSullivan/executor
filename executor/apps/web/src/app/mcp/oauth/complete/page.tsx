"use client";

import { useEffect, useRef } from "react";
import { useQuery as useTanstackQuery } from "@tanstack/react-query";

type PopupMessage =
  | {
      type: "executor:mcp-oauth-result";
      ok: true;
      sourceUrl: string;
      payload: {
        accessToken: string;
        refreshToken?: string;
        scope?: string;
        expiresIn?: number;
      };
    }
  | {
      type: "executor:mcp-oauth-result";
      ok: false;
      error: string;
    };

function fallbackErrorMessage(error: unknown): PopupMessage {
  return {
    type: "executor:mcp-oauth-result",
    ok: false,
    error: error instanceof Error ? error.message : "Failed to finalize OAuth",
  };
}

async function fetchPopupResult(): Promise<PopupMessage> {
  const response = await fetch("/mcp/oauth/result", {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
  });

  const data = await response.json() as PopupMessage;
  if (!data || data.type !== "executor:mcp-oauth-result") {
    throw new Error("Invalid OAuth completion payload");
  }
  return data;
}

export default function McpOAuthCompletePage() {
  const sentRef = useRef(false);
  const resultQuery = useTanstackQuery({
    queryKey: ["mcp-oauth-popup-result"],
    queryFn: fetchPopupResult,
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    if (sentRef.current || resultQuery.isPending) {
      return;
    }

    sentRef.current = true;
    const message = resultQuery.isSuccess
      ? resultQuery.data
      : fallbackErrorMessage(resultQuery.error);

    try {
      if (window.opener) {
        window.opener.postMessage(message, window.location.origin);
      }
    } finally {
      window.close();
    }
  }, [resultQuery.data, resultQuery.error, resultQuery.isPending, resultQuery.isSuccess]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="text-center space-y-2">
        <h1 className="text-base font-medium">Finishing OAuth</h1>
        <p className="text-sm text-muted-foreground">You can close this window if it does not close automatically.</p>
      </div>
    </main>
  );
}

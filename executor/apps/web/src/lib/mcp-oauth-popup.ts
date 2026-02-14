export type McpOAuthPopupSuccess = {
  sourceUrl: string;
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  expiresIn?: number;
};

type McpOAuthPopupMessage =
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

export async function startMcpOAuthPopup(sourceUrl: string): Promise<McpOAuthPopupSuccess> {
  if (typeof window === "undefined") {
    throw new Error("OAuth popup is only available in a browser context");
  }

  const startUrl = `/mcp/oauth/start?sourceUrl=${encodeURIComponent(sourceUrl)}`;
  const popup = window.open(
    startUrl,
    "executor-mcp-oauth",
    "popup=yes,width=520,height=720",
  );

  if (!popup) {
    throw new Error("Popup blocked. Allow popups and try again.");
  }

  return await new Promise<McpOAuthPopupSuccess>((resolve, reject) => {
    let settled = false;

    const closeAndReject = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(closedPoll);
      if (!popup.closed) {
        popup.close();
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as McpOAuthPopupMessage | undefined;
      if (!data || data.type !== "executor:mcp-oauth-result") {
        return;
      }

      if (!data.ok) {
        closeAndReject(data.error || "OAuth failed");
        return;
      }

      if (!data.payload?.accessToken) {
        closeAndReject("OAuth finished without an access token");
        return;
      }

      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve({
        sourceUrl: data.sourceUrl,
        accessToken: data.payload.accessToken,
        ...(data.payload.refreshToken ? { refreshToken: data.payload.refreshToken } : {}),
        ...(data.payload.scope ? { scope: data.payload.scope } : {}),
        ...(typeof data.payload.expiresIn === "number" ? { expiresIn: data.payload.expiresIn } : {}),
      });
    };

    window.addEventListener("message", onMessage);

    const closedPoll = window.setInterval(() => {
      if (popup.closed) {
        closeAndReject("OAuth popup was closed before completion");
      }
    }, 300);
  });
}

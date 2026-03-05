"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { startMcpOAuthPopup } from "../../../../lib/mcp/oauth-popup";

type InteractionStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled"
  | "expired"
  | "failed";

type InteractionRecord = {
  id: string;
  workspaceId: string;
  taskRunId: string;
  originServer: string;
  originRequestId: string;
  callId: string;
  toolPath: string;
  mode: "form" | "url";
  elicitationId: string | null;
  message: string;
  requestedSchemaJson: string | null;
  url: string | null;
  status: InteractionStatus;
  requestJson: string;
  responseAction: "accept" | "decline" | "cancel" | null;
  responseContentJson: string | null;
  reason: string | null;
  requestedAt: number;
  resolvedAt: number | null;
  completionNotifiedAt: number | null;
  expiresAt: number | null;
};

type PageProps = {
  params: {
    workspaceId: string;
    interactionId: string;
  };
};

const parseJsonRecord = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
};

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const prettyJson = (raw: string | null): string => {
  if (!raw || raw.trim().length === 0) {
    return "{}";
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
};

export default function InteractionPage({ params }: PageProps) {
  const workspaceId = params.workspaceId;
  const interactionId = params.interactionId;
  const [interaction, setInteraction] = useState<InteractionRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [secretValue, setSecretValue] = useState("");
  const [providerValue, setProviderValue] = useState("api_key");

  const fetchInteraction = useCallback(async (): Promise<void> => {
    if (!workspaceId || !interactionId) {
      return;
    }

    const response = await fetch(
      `/api/control-plane/v1/workspaces/${encodeURIComponent(workspaceId)}/interactions/${encodeURIComponent(interactionId)}`,
      {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
      },
    );

    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== "object") {
      throw new Error("Failed to load interaction");
    }

    setInteraction(payload as InteractionRecord);
  }, [workspaceId, interactionId]);

  useEffect(() => {
    if (!workspaceId || !interactionId) {
      return;
    }

    let active = true;
    const run = async () => {
      try {
        await fetchInteraction();
      } catch (nextError) {
        if (!active) {
          return;
        }

        setError(nextError instanceof Error ? nextError.message : "Failed to load interaction");
      }
    };

    void run();
    const interval = setInterval(() => {
      void run();
    }, 1_000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [workspaceId, interactionId, fetchInteraction]);

  const resolveInteraction = useCallback(async (input: {
    action: "accept" | "decline" | "cancel";
    reason?: string | null;
    contentJson?: string | null;
  }): Promise<void> => {
    if (!workspaceId || !interactionId) {
      return;
    }

    setBusy(true);
    setError(null);
    setStatusText(null);

    try {
      const response = await fetch(
        `/api/control-plane/v1/workspaces/${encodeURIComponent(workspaceId)}/interactions/${encodeURIComponent(interactionId)}/resolve`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          credentials: "same-origin",
          body: JSON.stringify({
            action: input.action,
            reason: input.reason ?? null,
            contentJson: input.contentJson ?? null,
          }),
        },
      );

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object") {
        throw new Error("Failed to resolve interaction");
      }

      setInteraction(payload as InteractionRecord);
      setStatusText(
        input.action === "accept"
          ? "Interaction accepted"
          : input.action === "decline"
            ? "Interaction declined"
            : "Interaction cancelled",
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to resolve interaction");
    } finally {
      setBusy(false);
    }
  }, [workspaceId, interactionId]);

  const requestPayload = useMemo(
    () => (interaction ? parseJsonRecord(interaction.requestJson) : null),
    [interaction],
  );

  const requestPurpose = readString(requestPayload?.purpose);
  const sourceEndpoint = readString(requestPayload?.endpoint) ?? interaction?.url ?? null;
  const canProvideSecret =
    interaction?.status === "pending" && requestPurpose === "source_connect_secret";
  const canStartOAuth =
    interaction?.status === "pending"
    && requestPurpose === "source_connect_oauth2"
    && sourceEndpoint !== null;

  const handleStartOAuth = useCallback(async (): Promise<void> => {
    if (!interaction || !sourceEndpoint) {
      return;
    }

    setBusy(true);
    setError(null);
    setStatusText(null);

    try {
      const oauthResult = await startMcpOAuthPopup(sourceEndpoint);
      await resolveInteraction({
        action: "accept",
        contentJson: JSON.stringify({
          accessToken: oauthResult.accessToken,
          refreshToken: oauthResult.refreshToken ?? null,
          scope: oauthResult.scope ?? null,
          expiresIn: oauthResult.expiresIn ?? null,
          clientId: oauthResult.clientId ?? null,
          clientInformationJson: oauthResult.clientInformationJson ?? null,
          sourceUrl: oauthResult.sourceUrl,
        }),
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "OAuth flow failed");
      setBusy(false);
    }
  }, [interaction, resolveInteraction, sourceEndpoint]);

  const handleProvideSecret = useCallback(async (): Promise<void> => {
    if (!secretValue.trim()) {
      setError("Secret is required");
      return;
    }

    await resolveInteraction({
      action: "accept",
      contentJson: JSON.stringify({
        secret: secretValue.trim(),
        provider: providerValue,
      }),
    });
  }, [providerValue, resolveInteraction, secretValue]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Resolve Interaction</h1>

      {!interaction ? (
        <p className="text-sm text-muted-foreground">Loading interaction...</p>
      ) : (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium">{interaction.message}</p>
          <p className="mt-1 text-xs text-muted-foreground">mode: {interaction.mode}</p>
          <p className="text-xs text-muted-foreground">status: {interaction.status}</p>
          <p className="mt-1 break-all text-xs text-muted-foreground">tool: {interaction.toolPath}</p>

          {interaction.url ? (
            <p className="mt-1 break-all text-xs text-muted-foreground">url: {interaction.url}</p>
          ) : null}

          <div className="mt-4 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">request</p>
            <pre className="max-h-64 overflow-auto rounded border border-border bg-muted/45 p-3 text-xs leading-5 text-muted-foreground">
              {prettyJson(interaction.requestJson)}
            </pre>
          </div>

          {interaction.requestedSchemaJson ? (
            <div className="mt-4 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">requested schema</p>
              <pre className="max-h-56 overflow-auto rounded border border-border bg-muted/45 p-3 text-xs leading-5 text-muted-foreground">
                {prettyJson(interaction.requestedSchemaJson)}
              </pre>
            </div>
          ) : null}

          {canProvideSecret ? (
            <div className="mt-4 space-y-2">
              <label className="flex flex-col gap-1 text-sm">
                Provider
                <select
                  className="rounded border border-border bg-background px-2 py-1.5"
                  value={providerValue}
                  onChange={(event) => setProviderValue(event.target.value)}
                  disabled={busy}
                >
                  <option value="api_key">api_key</option>
                  <option value="bearer">bearer</option>
                  <option value="basic">basic</option>
                  <option value="custom">custom</option>
                </select>
              </label>

              <label className="flex flex-col gap-1 text-sm">
                Secret
                <input
                  className="rounded border border-border bg-background px-2 py-1.5"
                  type="password"
                  value={secretValue}
                  onChange={(event) => setSecretValue(event.target.value)}
                  disabled={busy}
                />
              </label>

              <button
                type="button"
                className="rounded border border-border px-3 py-1.5 text-sm"
                disabled={busy}
                onClick={() => {
                  void handleProvideSecret();
                }}
              >
                Save Secret
              </button>
            </div>
          ) : null}

          {canStartOAuth ? (
            <div className="mt-4 space-y-2">
              <button
                type="button"
                className="rounded border border-border px-3 py-1.5 text-sm"
                disabled={busy}
                onClick={() => {
                  void handleStartOAuth();
                }}
              >
                Start OAuth Sign-In
              </button>
            </div>
          ) : null}

          {interaction.status === "pending" && !canStartOAuth && !canProvideSecret ? (
            <div className="mt-4 space-y-2">
              {interaction.url ? (
                <button
                  type="button"
                  className="rounded border border-border px-3 py-1.5 text-sm"
                  disabled={busy}
                  onClick={() => {
                    window.open(interaction.url!, "_blank", "noopener,noreferrer");
                  }}
                >
                  Open Interaction URL
                </button>
              ) : null}

              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded border border-border px-3 py-1.5 text-sm"
                  disabled={busy}
                  onClick={() => {
                    void resolveInteraction({ action: "accept" });
                  }}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="rounded border border-border px-3 py-1.5 text-sm"
                  disabled={busy}
                  onClick={() => {
                    void resolveInteraction({
                      action: "decline",
                      reason: "Declined in interaction UI",
                    });
                  }}
                >
                  Deny
                </button>
              </div>
            </div>
          ) : null}

          {statusText ? <p className="mt-3 text-sm">{statusText}</p> : null}
          {error ? <p className="mt-3 text-sm text-red-500">{error}</p> : null}
        </div>
      )}
    </main>
  );
}

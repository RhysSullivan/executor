"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { startMcpOAuthPopup } from "../../../../lib/mcp/oauth-popup";

type InteractionStatus = "pending" | "resolved" | "denied" | "expired" | "failed";
type InteractionKind = "approval" | "source_oauth_signin" | "provide_secret";

type InteractionRecord = {
  id: string;
  workspaceId: string;
  taskRunId: string;
  callId: string;
  toolPath: string;
  kind: InteractionKind;
  status: InteractionStatus;
  title: string;
  requestJson: string;
  resultJson: string | null;
  reason: string | null;
  requestedAt: number;
  resolvedAt: number | null;
  expiresAt: number | null;
};

type PageProps = {
  params: {
    workspaceId: string;
    interactionId: string;
  };
};

const parseRequestJson = (raw: string): Record<string, unknown> | null => {
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
    status: "resolved" | "denied";
    reason?: string | null;
    resultJson?: string | null;
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
            status: input.status,
            reason: input.reason ?? null,
            resultJson: input.resultJson ?? null,
          }),
        },
      );

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || typeof payload !== "object") {
        throw new Error("Failed to resolve interaction");
      }

      setInteraction(payload as InteractionRecord);
      setStatusText(input.status === "resolved" ? "Interaction resolved" : "Interaction denied");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to resolve interaction");
    } finally {
      setBusy(false);
    }
  }, [workspaceId, interactionId]);

  const requestPayload = useMemo(
    () => (interaction ? parseRequestJson(interaction.requestJson) : null),
    [interaction],
  );

  const sourceEndpoint = readString(requestPayload?.endpoint);

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
        status: "resolved",
        resultJson: JSON.stringify({
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
      status: "resolved",
      resultJson: JSON.stringify({
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
          <p className="text-sm font-medium">{interaction.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">kind: {interaction.kind}</p>
          <p className="text-xs text-muted-foreground">status: {interaction.status}</p>
          <p className="mt-1 break-all text-xs text-muted-foreground">tool: {interaction.toolPath}</p>

          {interaction.kind === "approval" && interaction.status === "pending" ? (
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="rounded border border-border px-3 py-1.5 text-sm"
                disabled={busy}
                onClick={() => {
                  void resolveInteraction({ status: "resolved" });
                }}
              >
                Approve
              </button>
              <button
                type="button"
                className="rounded border border-border px-3 py-1.5 text-sm"
                disabled={busy}
                onClick={() => {
                  void resolveInteraction({ status: "denied", reason: "Denied in interaction UI" });
                }}
              >
                Deny
              </button>
            </div>
          ) : null}

          {interaction.kind === "provide_secret" && interaction.status === "pending" ? (
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

          {interaction.kind === "source_oauth_signin" && interaction.status === "pending" ? (
            <div className="mt-4 space-y-2">
              <p className="text-xs text-muted-foreground break-all">
                source endpoint: {sourceEndpoint ?? "(missing endpoint in interaction payload)"}
              </p>
              <button
                type="button"
                className="rounded border border-border px-3 py-1.5 text-sm"
                disabled={busy || !sourceEndpoint}
                onClick={() => {
                  void handleStartOAuth();
                }}
              >
                Start OAuth Sign-In
              </button>
            </div>
          ) : null}

          {statusText ? <p className="mt-3 text-sm">{statusText}</p> : null}
          {error ? <p className="mt-3 text-sm text-red-500">{error}</p> : null}
        </div>
      )}
    </main>
  );
}

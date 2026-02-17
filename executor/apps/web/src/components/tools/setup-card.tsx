"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { Check, Copy } from "lucide-react";
import type { Id } from "@executor/database/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getAddMcpInstallConfig } from "@/components/tools/install-configs";
import { convexApi } from "@/lib/convex-api";

function inferServerName(workspaceId?: string): string {
  if (!workspaceId) return "executor";
  return `executor-${workspaceId.slice(0, 8).toLowerCase()}`;
}

function isAnonymousSessionId(sessionId?: string): boolean {
  if (!sessionId) return false;
  return sessionId.startsWith("anon_session_") || sessionId.startsWith("mcp_");
}

function isWorkosSessionId(sessionId?: string): boolean {
  if (!sessionId) return false;
  return sessionId.startsWith("workos_");
}

function resolveMcpOrigin(windowOrigin: string): string {
  const explicit = process.env.NEXT_PUBLIC_EXECUTOR_HTTP_URL ?? process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim().replace(/\/$/, "");
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (convexUrl) {
    try {
      const parsed = new URL(convexUrl);
      if (parsed.hostname.endsWith(".convex.cloud")) {
        parsed.hostname = parsed.hostname.replace(/\.convex\.cloud$/, ".convex.site");
      }
      return parsed.origin;
    } catch {
      // Fallback to web origin below.
    }
  }

  return windowOrigin;
}

export function McpSetupCard({
  workspaceId,
  sessionId,
}: {
  workspaceId?: Id<"workspaces">;
  sessionId?: string;
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const origin = useMemo(() => {
    if (typeof window === "undefined") return "";
    return resolveMcpOrigin(window.location.origin);
  }, []);

  const mcpUrl = useMemo(() => {
    const isAnonymousSession = isAnonymousSessionId(sessionId);
    const mcpPath = isAnonymousSession ? "/mcp/anonymous" : "/mcp";
    const base = origin ? new URL(mcpPath, origin) : new URL(`http://localhost${mcpPath}`);
    if (workspaceId) base.searchParams.set("workspaceId", workspaceId);
    if (!isAnonymousSession && sessionId && !isWorkosSessionId(sessionId)) {
      base.searchParams.set("sessionId", sessionId);
    }
    if (!origin) {
      return `${base.pathname}${base.search}`;
    }
    return base.toString();
  }, [origin, workspaceId, sessionId]);

  const isAnonymousSession = isAnonymousSessionId(sessionId);

  const anonymousMcpApiKey = useQuery(
    convexApi.workspace.getMcpApiKey,
    isAnonymousSession && workspaceId
      ? {
          workspaceId,
          sessionId
        }
      : "skip",
  );


  const apiKeyValue = anonymousMcpApiKey?.enabled
    ? anonymousMcpApiKey.apiKey
    : null;
  const apiKeyError = isAnonymousSession
    ? anonymousMcpApiKey?.enabled === false
      ? anonymousMcpApiKey.error
      : workspaceId
        ? null
        : "Workspace is required to issue an MCP API key"
    : null;

  const serverName = inferServerName(workspaceId);
  const installConfig = getAddMcpInstallConfig(
    mcpUrl,
    serverName,
    isAnonymousSession
      ? {
          apiKey: apiKeyValue ?? "your-api-key-here",
        }
      : undefined,
  );

  const copyText = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1500);
  };

  const codeLanguage = installConfig.type === "command"
    ? "bash"
    : installConfig.type;

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">MCP Server URL</Label>
        <div className="flex items-center gap-2">
          <Input value={mcpUrl} readOnly className="h-8 text-xs font-mono bg-background" />
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-8 w-8"
            onClick={() => void copyText("url", mcpUrl)}
          >
            {copiedKey === "url" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>

        {isAnonymousSession && (
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-2">
              <Input
                value={apiKeyValue ?? "Loading API key..."}
                readOnly
                className="h-8 text-xs font-mono bg-background"
              />
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-8 w-8"
                disabled={!apiKeyValue}
                onClick={() => apiKeyValue ? void copyText("api-key", apiKeyValue) : undefined}
              >
                {copiedKey === "api-key" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            {apiKeyError && <p className="text-[10px] text-destructive">{apiKeyError}</p>}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-[11px] text-muted-foreground">{installConfig.description}</p>
        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-foreground">
            <code className={`language-${codeLanguage}`}>{installConfig.content}</code>
          </pre>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => void copyText("install", installConfig.content)}
          >
            {copiedKey === "install" ? "Copied" : "Copy command"}
          </Button>
        </div>
      </div>

    </div>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MCP_PROVIDERS } from "@/components/tools/install-configs";
import { getAnonymousAuthToken } from "@/lib/anonymous-auth";
import { cn } from "@/lib/utils";

function inferServerName(workspaceId?: string): string {
  if (!workspaceId) return "executor";
  return `executor-${workspaceId.slice(0, 8).toLowerCase()}`;
}

function isAnonymousSessionId(sessionId?: string): boolean {
  if (!sessionId) return false;
  return sessionId.startsWith("anon_session_") || sessionId.startsWith("mcp_");
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
  workspaceId?: string;
  sessionId?: string;
}) {
  const [selectedProviderId, setSelectedProviderId] = useState(MCP_PROVIDERS[0]?.id ?? "claude-code");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [headersOpen, setHeadersOpen] = useState(false);
  const [anonymousAccessToken, setAnonymousAccessToken] = useState<string | null>(null);
  const [anonymousTokenError, setAnonymousTokenError] = useState<string | null>(null);

  const origin = useMemo(() => {
    if (typeof window === "undefined") return "";
    return resolveMcpOrigin(window.location.origin);
  }, []);

  const mcpUrl = useMemo(() => {
    const isAnonymousSession = isAnonymousSessionId(sessionId);
    const mcpPath = isAnonymousSession ? "/mcp/anonymous" : "/mcp";
    const base = origin ? new URL(mcpPath, origin) : new URL(`http://localhost${mcpPath}`);
    if (workspaceId) base.searchParams.set("workspaceId", workspaceId);
    if (!isAnonymousSession && sessionId) base.searchParams.set("sessionId", sessionId);
    if (!origin) {
      return `${base.pathname}${base.search}`;
    }
    return base.toString();
  }, [origin, workspaceId, sessionId]);

  const isAnonymousSession = isAnonymousSessionId(sessionId);

  useEffect(() => {
    let cancelled = false;

    if (!isAnonymousSession) {
      setAnonymousAccessToken(null);
      setAnonymousTokenError(null);
      return;
    }

    const hydrateToken = async () => {
      try {
        const token = await getAnonymousAuthToken();
        if (!cancelled) {
          setAnonymousAccessToken(token.accessToken);
          setAnonymousTokenError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setAnonymousAccessToken(null);
          setAnonymousTokenError(error instanceof Error ? error.message : "Failed to get anonymous token");
        }
      }
    };

    void hydrateToken();

    return () => {
      cancelled = true;
    };
  }, [isAnonymousSession, sessionId]);

  const headerLines = useMemo(() => {
    return [
      `Authorization: Bearer ${anonymousAccessToken ?? "<loading anonymous token...>"}`,
      "Accept: application/json, text/event-stream",
    ];
  }, [anonymousAccessToken]);

  const provider = MCP_PROVIDERS.find((item) => item.id === selectedProviderId) ?? MCP_PROVIDERS[0];
  if (!provider) {
    return (
      <div className="rounded-md border border-border bg-card/50 p-3 text-[11px] text-muted-foreground">
        MCP provider presets are unavailable.
      </div>
    );
  }
  const serverName = inferServerName(workspaceId);
  const providerConfig = provider.getConfig(mcpUrl, serverName);

  const copyText = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((current) => (current === key ? null : current)), 1500);
  };

  const codeLanguage = providerConfig.type === "command"
    ? "bash"
    : providerConfig.type;

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
          <Collapsible open={headersOpen} onOpenChange={setHeadersOpen}>
            <div className="mt-2">
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px] text-muted-foreground">
                  <ChevronRight
                    className={cn("mr-1 h-3 w-3 transition-transform", headersOpen && "rotate-90")}
                  />
                  {headersOpen ? "Hide headers" : "Set these headers also"}
                </Button>
              </CollapsibleTrigger>
            </div>

            <CollapsibleContent className="mt-1.5">
              <div className="rounded-md border border-border/60 bg-background/70 px-2.5 py-2 space-y-2">
                <div className="flex items-center justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 text-[10px]"
                    onClick={() => void copyText("headers", headerLines.join("\n"))}
                  >
                    {copiedKey === "headers" ? "Copied" : "Copy headers"}
                  </Button>
                </div>
                <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-foreground">
                  <code>{headerLines.join("\n")}</code>
                </pre>
                {anonymousTokenError && <p className="text-[10px] text-destructive">{anonymousTokenError}</p>}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Install For</Label>
        <Select value={selectedProviderId} onValueChange={setSelectedProviderId}>
          <SelectTrigger className="h-8 text-xs bg-background">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MCP_PROVIDERS.map((item) => (
              <SelectItem key={item.id} value={item.id} className="text-xs">
                <div className="flex items-center gap-2">
                  <Image
                    src={item.icon}
                    alt=""
                    width={14}
                    height={14}
                    className="h-3.5 w-3.5 rounded-sm"
                    unoptimized
                  />
                  <span>{item.name}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <p className="text-[11px] text-muted-foreground">{providerConfig.description}</p>
        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all text-foreground">
            <code className={`language-${codeLanguage}`}>{providerConfig.content}</code>
          </pre>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => void copyText("provider", providerConfig.content)}
          >
            {copiedKey === "provider" ? "Copied" : "Copy snippet"}
          </Button>
        </div>
      </div>

    </div>
  );
}

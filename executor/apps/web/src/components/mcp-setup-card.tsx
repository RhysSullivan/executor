"use client";

import { useMemo, useState } from "react";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MCP_PROVIDERS } from "@/components/mcp-install-configs";

function inferServerName(workspaceId?: string): string {
  if (!workspaceId) return "executor";
  return `executor-${workspaceId.slice(0, 8).toLowerCase()}`;
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
  actorId,
}: {
  workspaceId?: string;
  actorId?: string;
}) {
  const [selectedProviderId, setSelectedProviderId] = useState(MCP_PROVIDERS[0]?.id ?? "claude-code");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const origin = useMemo(() => {
    if (typeof window === "undefined") return "";
    return resolveMcpOrigin(window.location.origin);
  }, []);

  const mcpUrl = useMemo(() => {
    const base = origin ? new URL("/mcp", origin) : new URL("http://localhost/mcp");
    if (workspaceId) base.searchParams.set("workspaceId", workspaceId);
    if (actorId) base.searchParams.set("actorId", actorId);
    if (!origin) {
      return `${base.pathname}${base.search}`;
    }
    return base.toString();
  }, [origin, workspaceId, actorId]);

  const protectedResourceUrl = useMemo(() => {
    if (!origin) return "/.well-known/oauth-protected-resource";
    return `${origin}/.well-known/oauth-protected-resource`;
  }, [origin]);

  const authorizationServerMetadataUrl = useMemo(() => {
    if (!origin) return "/.well-known/oauth-authorization-server";
    return `${origin}/.well-known/oauth-authorization-server`;
  }, [origin]);

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
                  <img src={item.icon} alt="" className="h-3.5 w-3.5 rounded-sm" />
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

      <div className="rounded-md border border-border bg-card/50 p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-primary" />
          OAuth Setup (AuthKit)
        </div>
        <p className="text-[11px] text-muted-foreground">
          Set <code>MCP_AUTHORIZATION_SERVER</code> to your AuthKit issuer (for example <code>https://your-app.authkit.app</code>) to require bearer tokens on <code>/mcp</code>.
        </p>
        <p className="text-[11px] text-muted-foreground">
          The server publishes metadata at <code>{protectedResourceUrl}</code> and <code>{authorizationServerMetadataUrl}</code> so MCP clients can discover OAuth endpoints automatically.
        </p>
        <p className="text-[11px] text-muted-foreground">
          If OAuth is enabled, <code>workspaceId</code> is required in the MCP URL and <code>actorId</code> is derived from token <code>sub</code>.
        </p>
      </div>
    </div>
  );
}

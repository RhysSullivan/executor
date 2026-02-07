"use client";

import { useState } from "react";
import {
  Wrench,
  Plus,
  Trash2,
  RefreshCw,
  ShieldCheck,
  Globe,
  Server,
  Zap,
  Search,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { useSession } from "@/lib/session-context";
import { usePoll } from "@/hooks/use-poll";
import * as api from "@/lib/api";
import type { ToolSourceRecord, ToolDescriptor } from "@/lib/types";
import { parse as parseDomain } from "tldts";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── Add Source Dialog ──

const RAW_HOSTS = new Set([
  "raw.githubusercontent.com",
  "cdn.jsdelivr.net",
  "unpkg.com",
  "raw.github.com",
]);

function inferNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parsed = parseDomain(url);

    // For raw/CDN hosts, infer from the first meaningful path segment
    // e.g. raw.githubusercontent.com/github/rest-api-description/... -> "github"
    if (RAW_HOSTS.has(u.hostname)) {
      const segments = u.pathname.split("/").filter(Boolean);
      if (segments.length > 0) return segments[0].toLowerCase();
    }

    // For subdomains like "api.github.com", prefer the domain name
    if (parsed.domainWithoutSuffix) {
      return parsed.domainWithoutSuffix;
    }

    if (parsed.domain) {
      return parsed.domain.split(".")[0];
    }

    return u.hostname.replace(/\./g, "-");
  } catch {
    return "";
  }
}

function AddSourceDialog({ onAdded }: { onAdded: () => void }) {
  const { context } = useSession();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<"mcp" | "openapi">("mcp");
  const [name, setName] = useState("");
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleEndpointChange = (value: string) => {
    setEndpoint(value);
    // Auto-infer name from URL if user hasn't manually edited the name
    if (!nameManuallyEdited) {
      const inferred = inferNameFromUrl(value);
      if (inferred) setName(inferred);
    }
  };

  const handleNameChange = (value: string) => {
    setName(value);
    setNameManuallyEdited(true);
  };

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) {
      // Reset on close
      setName("");
      setEndpoint("");
      setBaseUrl("");
      setNameManuallyEdited(false);
    }
  };

  const handleSubmit = async () => {
    if (!context || !name.trim() || !endpoint.trim()) return;
    setSubmitting(true);
    try {
      const config: Record<string, unknown> =
        type === "mcp"
          ? { url: endpoint }
          : { spec: endpoint, ...(baseUrl ? { baseUrl } : {}) };

      const result = await api.upsertToolSource({
        workspaceId: context.workspaceId,
        name: name.trim(),
        type,
        config,
      });
      const warnings = (result as unknown as Record<string, unknown>).warnings as string[] | undefined;
      if (warnings && warnings.length > 0) {
        toast.warning(`Source "${name}" saved but had issues`, {
          description: warnings.join("\n"),
          duration: 10000,
        });
      } else {
        toast.success(`Source "${name}" added`);
      }
      setName("");
      setEndpoint("");
      setBaseUrl("");
      setNameManuallyEdited(false);
      setOpen(false);
      onAdded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add source");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8 text-xs">
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add Source
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">
            Add Tool Source
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Type</Label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as "mcp" | "openapi")}
            >
              <SelectTrigger className="h-8 text-xs bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mcp" className="text-xs">
                  MCP Server
                </SelectItem>
                <SelectItem value="openapi" className="text-xs">
                  OpenAPI Spec
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              {type === "mcp" ? "Endpoint URL" : "Spec URL"}
            </Label>
            <Input
              value={endpoint}
              onChange={(e) => handleEndpointChange(e.target.value)}
              placeholder={
                type === "mcp"
                  ? "https://mcp-server.example.com/sse"
                  : "https://api.example.com/openapi.json"
              }
              className="h-8 text-xs font-mono bg-background"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. my-service"
              className="h-8 text-xs font-mono bg-background"
            />
          </div>
          {type === "openapi" && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                Base URL (optional)
              </Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com"
                className="h-8 text-xs font-mono bg-background"
              />
            </div>
          )}
          <Button
            onClick={handleSubmit}
            disabled={submitting || !name.trim() || !endpoint.trim()}
            className="w-full h-9"
            size="sm"
          >
            {submitting ? "Adding..." : "Add Source"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Source Card ──

function SourceCard({
  source,
  onDeleted,
}: {
  source: ToolSourceRecord;
  onDeleted: () => void;
}) {
  const { context } = useSession();
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!context) return;
    setDeleting(true);
    try {
      await api.deleteToolSource(context.workspaceId, source.id);
      toast.success(`Removed "${source.name}"`);
      onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  };

  const TypeIcon = source.type === "mcp" ? Server : Globe;

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-md bg-muted/40 group">
      <div className="h-8 w-8 rounded bg-muted flex items-center justify-center shrink-0">
        <TypeIcon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono font-medium truncate">
            {source.name}
          </span>
          <Badge
            variant="outline"
            className="text-[9px] font-mono uppercase tracking-wider"
          >
            {source.type}
          </Badge>
          {!source.enabled && (
            <Badge
              variant="outline"
              className="text-[9px] font-mono uppercase tracking-wider text-terminal-red border-terminal-red/30"
            >
              disabled
            </Badge>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground font-mono truncate block">
          {source.type === "mcp"
            ? (source.config.url as string)
            : (source.config.spec as string)}
        </span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-terminal-red shrink-0"
        onClick={handleDelete}
        disabled={deleting}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// ── Tool Inventory ──

function ToolInventory({ tools }: { tools: ToolDescriptor[] }) {
  const [search, setSearch] = useState("");

  const filtered = tools.filter(
    (t) =>
      t.path.toLowerCase().includes(search.toLowerCase()) ||
      t.description.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tools..."
          className="h-8 text-xs pl-8 bg-background"
        />
      </div>
      <div className="space-y-1 max-h-[500px] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            {search ? "No tools match your search" : "No tools available"}
          </div>
        ) : (
          filtered.map((tool) => (
            <div
              key={tool.path}
              className="flex items-start gap-3 px-3 py-2.5 rounded-md hover:bg-accent/30 transition-colors"
            >
              <Zap className="h-3.5 w-3.5 mt-0.5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-mono font-medium">
                    {tool.path}
                  </span>
                  {tool.approval === "required" && (
                    <span className="inline-flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider text-terminal-amber bg-terminal-amber/10 px-1.5 py-0.5 rounded border border-terminal-amber/20">
                      <ShieldCheck className="h-2.5 w-2.5" />
                      approval
                    </span>
                  )}
                  {tool.source && (
                    <span className="text-[9px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {tool.source}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  {tool.description}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Tools View ──

export function ToolsView() {
  const { context, loading: sessionLoading } = useSession();

  const {
    data: sources,
    loading: sourcesLoading,
    refresh: refreshSources,
  } = usePoll({
    fetcher: () => api.listToolSources(context!.workspaceId),
    enabled: !!context,
    interval: 10000,
  });

  const {
    data: tools,
    loading: toolsLoading,
    refresh: refreshTools,
  } = usePoll({
    fetcher: () =>
      api.listToolsForContext({
        workspaceId: context!.workspaceId,
        actorId: context!.actorId,
        clientId: context!.clientId,
      }),
    enabled: !!context,
    interval: 10000,
  });

  const refreshAll = () => {
    refreshSources();
    refreshTools();
  };

  if (sessionLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tools"
        description="Manage tool sources and view available tools"
      >
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          onClick={refreshAll}
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Refresh
        </Button>
      </PageHeader>

      <Tabs defaultValue="sources" className="w-full">
        <TabsList className="bg-muted/50 h-9">
          <TabsTrigger value="sources" className="text-xs data-[state=active]:bg-background">
            Sources
            {sources && (
              <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">
                {sources.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="inventory" className="text-xs data-[state=active]:bg-background">
            Inventory
            {tools && (
              <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">
                {tools.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="sources" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Server className="h-4 w-4 text-muted-foreground" />
                  Tool Sources
                </CardTitle>
                <AddSourceDialog onAdded={refreshAll} />
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {sourcesLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-16" />
                  ))}
                </div>
              ) : !sources || sources.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                  <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
                    <Wrench className="h-6 w-6 text-muted-foreground/40" />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    No external tool sources
                  </p>
                  <p className="text-[11px] text-muted-foreground/60">
                    Add MCP or OpenAPI sources to extend available tools
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {sources.map((s) => (
                    <SourceCard key={s.id} source={s} onDeleted={refreshAll} />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="inventory" className="mt-4">
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Zap className="h-4 w-4 text-primary" />
                Available Tools
                {tools && (
                  <span className="text-[10px] font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                    {tools.length}
                  </span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {toolsLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-14" />
                  ))}
                </div>
              ) : (
                <ToolInventory tools={tools ?? []} />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

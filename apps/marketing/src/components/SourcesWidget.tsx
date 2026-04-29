import { useState, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DetectedSource {
  kind: string;
  name: string;
  count: number;
  tools: { name: string; desc: string; method: string; policy: string }[];
  favicon: string;
}

// ---------------------------------------------------------------------------
// Preset quick-add buttons
// ---------------------------------------------------------------------------

const PRESETS = [
  { label: "Stripe", url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json", domain: "stripe.com" },
  { label: "GitHub", url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json", domain: "github.com" },
  { label: "Vercel", url: "https://openapi.vercel.sh", domain: "vercel.com" },
  { label: "Cloudflare", url: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json", domain: "cloudflare.com" },
  { label: "Linear", url: "https://api.linear.app/graphql", domain: "linear.app" },
] as const;

function faviconUrl(domain: string) {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
}

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^(www|api|raw)\./, "").replace(/^githubusercontent\.com$/, "github.com");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Policy badge color
// ---------------------------------------------------------------------------

function policyColor(policy: string) {
  switch (policy) {
    case "read":
      return "bg-emerald-100 text-emerald-700";
    case "write":
      return "bg-amber-100 text-amber-700";
    case "destructive":
      return "bg-red-100 text-red-700";
    default:
      return "bg-neutral-100 text-neutral-600";
  }
}

function methodColor(method: string) {
  switch (method.toUpperCase()) {
    case "GET":
    case "QUERY":
      return "text-emerald-600";
    case "POST":
    case "MUTATION":
      return "text-blue-600";
    case "PUT":
    case "PATCH":
      return "text-amber-600";
    case "DELETE":
      return "text-red-600";
    default:
      return "text-neutral-500";
  }
}

// ---------------------------------------------------------------------------
// SourcesWidget
// ---------------------------------------------------------------------------

export default function SourcesWidget() {
  const [url, setUrl] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<DetectedSource[]>([]);
  const [expandedSource, setExpandedSource] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const detect = useCallback(
    async (targetUrl: string) => {
      const trimmed = targetUrl.trim();
      if (!trimmed) return;

      setDetecting(true);
      setError(null);

      try {
        const res = await fetch("/api/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error || "Detection failed");
          setDetecting(false);
          return;
        }

        const data = (await res.json()) as {
          kind: string;
          name: string;
          count: number;
          tools: { name: string; desc: string; method: string; policy: string }[];
        };

        const domain = domainFromUrl(trimmed);
        const preset = PRESETS.find((p) => p.url === trimmed);
        const favicon = preset
          ? faviconUrl(preset.domain)
          : domain
            ? faviconUrl(domain)
            : "";

        const newSource: DetectedSource = { ...data, favicon };

        setSources((prev) => {
          // Don't add duplicates
          if (prev.some((s) => s.name === newSource.name)) return prev;
          return [...prev, newSource];
        });
        setExpandedSource(sources.length);
        setUrl("");
      } catch {
        setError("Detection failed. Try a different URL.");
      } finally {
        setDetecting(false);
      }
    },
    [sources.length],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      detect(url);
    },
    [url, detect],
  );

  const handlePreset = useCallback(
    (presetUrl: string) => {
      setUrl(presetUrl);
      detect(presetUrl);
    },
    [detect],
  );

  const totalTools = sources.reduce((sum, s) => sum + s.count, 0);

  return (
    <div className="mx-auto w-full max-w-2xl">
      {/* Card stack container */}
      <div className="overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/40 px-5 py-3">
          <span className="text-sm font-medium text-foreground">Sources</span>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {sources.length > 0 && (
              <>
                <span>{sources.length} connected</span>
                <span className="text-border">|</span>
                <span>{totalTools} tools</span>
              </>
            )}
          </div>
        </div>

        {/* URL input */}
        <form onSubmit={handleSubmit} className="border-b border-border/40 px-5 py-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              {/* oxlint-disable-next-line react/forbid-elements */}
              <input
                ref={inputRef}
                type="url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setError(null);
                }}
                placeholder="Paste an OpenAPI or GraphQL URL..."
                disabled={detecting}
                className={cn(
                  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors",
                  "placeholder:text-muted-foreground/60",
                  "focus:border-ring focus:ring-1 focus:ring-ring/40",
                  "disabled:opacity-50",
                )}
              />
            </div>
            <Button
              type="submit"
              disabled={detecting || !url.trim()}
              className="shrink-0"
              size="default"
            >
              {detecting ? (
                <span className="flex items-center gap-1.5">
                  <svg className="size-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                    <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  Detecting
                </span>
              ) : (
                "Detect"
              )}
            </Button>
          </div>

          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}

          {/* Quick-add presets */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground/60">Try:</span>
            {PRESETS.map((p) => {
              const alreadyAdded = sources.some(
                (s) => s.name.toLowerCase().includes(p.label.toLowerCase()),
              );
              // oxlint-disable-next-line react/forbid-elements
              return (<button
                  key={p.label}
                  type="button"
                  disabled={detecting || alreadyAdded}
                  onClick={() => handlePreset(p.url)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 text-xs font-medium transition-colors",
                    alreadyAdded
                      ? "opacity-40 cursor-default"
                      : "hover:bg-muted cursor-pointer",
                  )}
                >
                  <img
                    src={faviconUrl(p.domain)}
                    alt=""
                    className="size-3 rounded-sm"
                    loading="lazy"
                  />
                  {p.label}
                </button>
              );
            })}
          </div>
        </form>

        {/* Source list */}
        {sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-14 text-muted-foreground/50">
            <svg viewBox="0 0 24 24" fill="none" className="size-8 mb-2">
              <path
                d="M12 6v12M6 12h12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <p className="text-sm">Add a source to see its tools</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {sources.map((source, i) => {
              const isExpanded = expandedSource === i;
              return (
                <div key={source.name}>
                  {/* Source entry */}
                  {/* oxlint-disable-next-line react/forbid-elements */}
                  <button
                    type="button"
                    onClick={() => setExpandedSource(isExpanded ? null : i)}
                    className={cn(
                      "flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-muted/40",
                      i > 0 && "border-t border-border/30",
                    )}
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                      {source.favicon ? (
                        <img
                          src={source.favicon}
                          alt=""
                          className="size-5 rounded-sm object-contain"
                        />
                      ) : (
                        <svg viewBox="0 0 16 16" className="size-3.5" fill="none">
                          <circle
                            cx="8"
                            cy="8"
                            r="6"
                            stroke="currentColor"
                            strokeWidth="1.2"
                          />
                        </svg>
                      )}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium text-foreground">
                        {source.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {source.count} tools
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                        {source.kind}
                      </span>
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        className={cn(
                          "size-3.5 text-muted-foreground transition-transform duration-200",
                          isExpanded && "rotate-180",
                        )}
                      >
                        <path
                          d="M4 6l4 4 4-4"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                  </button>

                  {/* Expanded tool list */}
                  {isExpanded && source.tools.length > 0 && (
                    <div className="border-t border-border/30 bg-muted/20">
                      <div className="max-h-[240px] overflow-y-auto">
                        {source.tools.map((tool) => (
                          <div
                            key={tool.name}
                            className="flex items-center gap-3 border-b border-border/20 px-5 py-2 last:border-b-0"
                          >
                            <span
                              className={cn(
                                "w-12 shrink-0 text-right font-mono text-[10px] font-semibold uppercase",
                                methodColor(tool.method),
                              )}
                            >
                              {tool.method}
                            </span>
                            <div className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate font-mono text-xs text-foreground">
                                {tool.name}
                              </span>
                              <span className="truncate text-[11px] text-muted-foreground">
                                {tool.desc}
                              </span>
                            </div>
                            <span
                              className={cn(
                                "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                                policyColor(tool.policy),
                              )}
                            >
                              {tool.policy}
                            </span>
                          </div>
                        ))}
                      </div>
                      {source.count > source.tools.length && (
                        <div className="border-t border-border/30 px-5 py-2 text-center text-xs text-muted-foreground">
                          + {source.count - source.tools.length} more tools
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

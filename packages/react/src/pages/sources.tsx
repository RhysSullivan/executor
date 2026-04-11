import { useState, useCallback, useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Result, useAtomValue, useAtomSet } from "@effect-atom/atom-react";
import { sourcesAtom, detectSource } from "../api/atoms";
import { useScope } from "../hooks/use-scope";
import type { SourcePlugin, SourcePreset } from "../plugins/source-plugin";
import { McpInstallCard } from "../components/mcp-install-card";
import { Button } from "../components/button";
import { Input } from "../components/input";

const KIND_TO_PLUGIN_KEY: Record<string, string> = {
  openapi: "openapi",
  mcp: "mcp",
  graphql: "graphql",
  googleDiscovery: "googleDiscovery",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SourcesPage(props: { sourcePlugins: readonly SourcePlugin[] }) {
  const { sourcePlugins } = props;
  const [url, setUrl] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeId = useScope();
  const sources = useAtomValue(sourcesAtom(scopeId));
  const doDetect = useAtomSet(detectSource, { mode: "promise" });
  const navigate = useNavigate();

  const handleDetect = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setDetecting(true);
    setError(null);
    try {
      const results = await doDetect({
        path: { scopeId },
        payload: { url: trimmed },
      });
      if (results.length === 0) {
        setError("Could not detect a source type from this URL. Try adding manually.");
        setDetecting(false);
        return;
      }
      const pluginKey = KIND_TO_PLUGIN_KEY[results[0].kind];
      if (pluginKey) {
        void navigate({
          to: "/sources/add/$pluginKey",
          params: { pluginKey },
          search: { url: trimmed, namespace: results[0].namespace },
        });
      } else {
        setError(`Detected source type "${results[0].kind}" but no plugin is available for it.`);
      }
    } catch {
      setError("Detection failed. Try adding a source manually.");
    } finally {
      setDetecting(false);
    }
  }, [url, doDetect, navigate, scopeId]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-end justify-between">
            <div>
              <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
                Sources
              </h1>
              <p className="mt-1.5 text-[14px] text-muted-foreground">
                Tool providers available in this workspace.
              </p>
            </div>
          </div>

          {/* URL detection input */}
          <div className="mt-5">
            <div className="flex gap-2">
              <Input
                type="url"
                value={url}
                onChange={(e) => {
                  setUrl((e.target as HTMLInputElement).value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleDetect();
                }}
                placeholder="Paste a URL to auto-detect source type..."
                disabled={detecting}
                className="flex-1"
              />
              <Button onClick={handleDetect} disabled={detecting || !url.trim()}>
                {detecting ? "Detecting..." : "Detect"}
              </Button>
            </div>
            {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              <span>Or add manually:</span>
              {sourcePlugins.map((p) => (
                <Link
                  key={p.key}
                  to="/sources/add/$pluginKey"
                  params={{ pluginKey: p.key }}
                  className="rounded-md border border-border px-2 py-1 text-xs font-medium transition-colors hover:bg-muted"
                >
                  {p.label}
                </Link>
              ))}
            </div>
          </div>
        </div>

        <McpInstallCard className="mb-8 rounded-2xl border border-border bg-card/80 p-5" />

        <PresetGrid plugins={sourcePlugins} />

        {Result.match(sources, {
          onInitial: () => <p className="text-sm text-muted-foreground">Loading…</p>,
          onFailure: () => <p className="text-sm text-destructive">Failed to load sources</p>,
          onSuccess: ({ value }) => {
            const builtInSources = value.filter((source) => source.runtime);
            const connectedSources = value.filter((source) => !source.runtime);

            return value.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground mb-4">
                  <svg viewBox="0 0 24 24" fill="none" className="size-5">
                    <path
                      d="M12 6v12M6 12h12"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
                <p className="text-[14px] font-medium text-foreground/70 mb-1">No sources yet</p>
                <p className="text-[13px] text-muted-foreground/60 mb-5">
                  Add a source to get started.
                </p>
              </div>
            ) : (
              <div className="space-y-8">
                {builtInSources.length > 0 && (
                  <section className="space-y-3">
                    <div>
                      <h2 className="text-sm font-semibold text-foreground">Built-in</h2>
                      <p className="mt-1 text-[13px] text-muted-foreground">
                        Runtime sources exposed by the loaded executor plugins.
                      </p>
                    </div>
                    <SourceGrid sources={builtInSources} />
                  </section>
                )}

                {connectedSources.length > 0 && (
                  <section className="space-y-3">
                    <div>
                      <h2 className="text-sm font-semibold text-foreground">Connected</h2>
                      <p className="mt-1 text-[13px] text-muted-foreground">
                        User-configured sources available in this workspace.
                      </p>
                    </div>
                    <SourceGrid sources={connectedSources} />
                  </section>
                )}
              </div>
            );
          },
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preset grid
// ---------------------------------------------------------------------------

type PresetEntry = { preset: SourcePreset; pluginKey: string; pluginLabel: string };

function PresetCard({ preset, pluginKey, pluginLabel }: PresetEntry) {
  const search: Record<string, string> = { preset: preset.id };
  if (preset.url) search.url = preset.url;

  return (
    <Link
      to="/sources/add/$pluginKey"
      params={{ pluginKey }}
      search={search}
      className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary/25 hover:bg-card/90"
    >
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground overflow-hidden">
        {preset.icon ? (
          <img src={preset.icon} alt="" className="size-5 object-contain" loading="lazy" />
        ) : (
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{preset.name}</span>
          <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
            {pluginLabel}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{preset.summary}</p>
      </div>
    </Link>
  );
}

function PresetGrid(props: { plugins: readonly SourcePlugin[] }) {
  const allPresets = useMemo(() => {
    const entries: PresetEntry[] = [];
    for (const plugin of props.plugins) {
      for (const preset of plugin.presets ?? []) {
        entries.push({ preset, pluginKey: plugin.key, pluginLabel: plugin.label });
      }
    }
    return entries;
  }, [props.plugins]);

  if (allPresets.length === 0) return null;

  return (
    <section className="mb-8 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Popular sources</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          One-click setup for common APIs and services.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {allPresets.map((entry) => (
          <PresetCard key={`${entry.pluginKey}-${entry.preset.id}`} {...entry} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Source grid
// ---------------------------------------------------------------------------

function SourceGrid(props: {
  sources: readonly { id: string; name: string; kind: string; runtime?: boolean }[];
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {props.sources.map((s) => (
        <Link
          key={s.id}
          to="/sources/$namespace"
          params={{ namespace: s.id }}
          className="flex h-full flex-col rounded-2xl border border-border bg-card px-5 py-4 transition-colors hover:border-primary/25 hover:bg-card/90"
        >
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <svg viewBox="0 0 16 16" className="size-4">
                <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" />
                <path
                  d="M8 5v6M5 8h6"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <div className="truncate text-sm font-semibold text-foreground">{s.name}</div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {s.runtime && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      built-in
                    </span>
                  )}
                  <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                    {s.kind}
                  </span>
                </div>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{s.id}</div>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

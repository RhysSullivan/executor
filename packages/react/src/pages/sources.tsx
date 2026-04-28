import { Suspense, useState, useCallback, useMemo } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Result, useAtomSet } from "@effect-atom/atom-react";
import { detectSource } from "../api/atoms";
import { useSourcesWithPending } from "../api/optimistic";
import { useScope } from "../hooks/use-scope";
import type { SourcePlugin, SourcePreset } from "../plugins/source-plugin";
import { McpInstallCard } from "../components/mcp-install-card";
import { Button } from "../components/button";
import { Badge } from "../components/badge";
import { Input } from "../components/input";
import {
  CardStack,
  CardStackHeader,
  CardStackContent,
  CardStackEntry,
  CardStackEntryField,
  CardStackEntryMedia,
  CardStackEntryContent,
  CardStackEntryTitle,
  CardStackEntryDescription,
  CardStackEntryActions,
} from "../components/card-stack";
import { SourceFavicon } from "../components/source-favicon";
import { Skeleton } from "../components/skeleton";

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
  const sources = useSourcesWithPending(scopeId);
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
            <CardStack>
              <CardStackContent>
                <CardStackEntryField
                  label="Paste URL"
                  description="auto-detect source type"
                  hint={error ?? undefined}
                >
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
                      placeholder="https://..."
                      disabled={detecting}
                      className="flex-1"
                    />
                    <Button onClick={handleDetect} disabled={detecting || !url.trim()}>
                      {detecting ? "Detecting..." : "Detect"}
                    </Button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    Or add manually:{" "}
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
                </CardStackEntryField>
              </CardStackContent>
            </CardStack>
          </div>
        </div>

        <div className="mb-8">
          <McpInstallCard />
        </div>

        {Result.match(sources, {
          onInitial: () => <SourcesGridSkeleton />,
          onFailure: () => <p className="text-sm text-destructive">Failed to load sources</p>,
          onSuccess: ({ value }) => {
            const connectedSources = value.filter((source) => !source.runtime);

            return value.length === 0 ? (
              <div className="mb-8 flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
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
              <div className="mb-8 space-y-8">
                {connectedSources.length > 0 && (
                  <section className="space-y-3">
                    <SourceGrid
                      sources={connectedSources}
                      sourcePlugins={sourcePlugins}
                    />
                  </section>
                )}
              </div>
            );
          },
        })}

        <div className="mb-8 border-t border-border/50" />

        <PresetGrid plugins={sourcePlugins} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preset grid
// ---------------------------------------------------------------------------

type PresetEntry = {
  preset: SourcePreset;
  pluginKey: string;
  pluginLabel: string;
};

function PresetGrid(props: { plugins: readonly SourcePlugin[] }) {
  const allPresets = useMemo(() => {
    const entries: PresetEntry[] = [];
    for (const plugin of props.plugins) {
      for (const preset of plugin.presets ?? []) {
        entries.push({
          preset,
          pluginKey: plugin.key,
          pluginLabel: plugin.label,
        });
      }
    }
    return entries;
  }, [props.plugins]);

  if (allPresets.length === 0) return null;

  return (
    <section className="mb-8 space-y-3">
      <CardStack searchable>
        <CardStackHeader>Popular sources</CardStackHeader>
        <CardStackContent>
          {allPresets.map(({ preset, pluginKey, pluginLabel }) => {
            const search: Record<string, string> = { preset: preset.id };
            if (preset.url) search.url = preset.url;
            return (
              <CardStackEntry
                key={`${pluginKey}-${preset.id}`}
                asChild
                searchText={`${preset.name} ${preset.summary ?? ""} ${pluginLabel}`}
              >
                <Link to="/sources/add/$pluginKey" params={{ pluginKey }} search={search}>
                  <CardStackEntryMedia>
                    {preset.icon ? (
                      <img
                        src={preset.icon}
                        alt=""
                        className="size-5 object-contain"
                        loading="lazy"
                      />
                    ) : (
                      <svg viewBox="0 0 16 16" className="size-3.5" fill="none">
                        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
                      </svg>
                    )}
                  </CardStackEntryMedia>
                  <CardStackEntryContent>
                    <CardStackEntryTitle>{preset.name}</CardStackEntryTitle>
                    <CardStackEntryDescription>{preset.summary}</CardStackEntryDescription>
                  </CardStackEntryContent>
                  <CardStackEntryActions>
                    <Badge variant="secondary">{pluginLabel}</Badge>
                  </CardStackEntryActions>
                </Link>
              </CardStackEntry>
            );
          })}
        </CardStackContent>
      </CardStack>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Source grid
// ---------------------------------------------------------------------------

function SourceGrid(props: {
  sources: readonly {
    id: string;
    name: string;
    kind: string;
    url?: string;
    runtime?: boolean;
  }[];
  sourcePlugins: readonly SourcePlugin[];
}) {
  const pluginByKind = useMemo(() => {
    const out = new Map<string, SourcePlugin>();
    for (const p of props.sourcePlugins) out.set(p.key, p);
    return out;
  }, [props.sourcePlugins]);

  return (
    <CardStack searchable>
      <CardStackHeader>Connected</CardStackHeader>
      <CardStackContent>
        {props.sources.map((s) => {
          const pluginKey = KIND_TO_PLUGIN_KEY[s.kind] ?? s.kind;
          const plugin = pluginByKind.get(pluginKey);
          const SummaryComponent = plugin?.summary;
          return (
            <CardStackEntry key={s.id} asChild searchText={`${s.name} ${s.id} ${s.kind}`}>
              <Link to="/sources/$namespace" params={{ namespace: s.id }}>
                <CardStackEntryMedia>
                  <SourceFavicon url={s.url} size={32} />
                </CardStackEntryMedia>
                <CardStackEntryContent>
                  <CardStackEntryTitle>{s.name}</CardStackEntryTitle>
                  <CardStackEntryDescription>{s.id}</CardStackEntryDescription>
                </CardStackEntryContent>
                <CardStackEntryActions>
                  {SummaryComponent && (
                    <Suspense fallback={null}>
                      <SummaryComponent sourceId={s.id} />
                    </Suspense>
                  )}
                  {s.runtime && <Badge className="bg-muted text-muted-foreground">built-in</Badge>}
                  <Badge variant="secondary">{s.kind}</Badge>
                </CardStackEntryActions>
              </Link>
            </CardStackEntry>
          );
        })}
      </CardStackContent>
    </CardStack>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function SourcesGridSkeleton() {
  return (
    <CardStack>
      <CardStackContent>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-8 shrink-0 rounded-md" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-4" style={{ width: `${40 + ((i * 11) % 30)}%` }} />
              <Skeleton className="h-3" style={{ width: `${25 + ((i * 7) % 20)}%` }} />
            </div>
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
        ))}
      </CardStackContent>
    </CardStack>
  );
}

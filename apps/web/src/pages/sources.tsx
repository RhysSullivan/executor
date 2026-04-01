import { useState, Suspense } from "react";
import { Link } from "@tanstack/react-router";
import { Result, useAtomValue, useAtomRefresh, sourcesAtom } from "@executor/react";
import type { SourcePlugin } from "@executor/react";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";

// ---------------------------------------------------------------------------
// Registered source plugins
// ---------------------------------------------------------------------------

const sourcePlugins: SourcePlugin[] = [openApiSourcePlugin];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SourcesPage() {
  const [adding, setAdding] = useState<string | null>(null);
  const sources = useAtomValue(sourcesAtom());
  const refreshSources = useAtomRefresh(sourcesAtom());

  const plugin = adding
    ? sourcePlugins.find((p) => p.key === adding)
    : undefined;

  if (plugin) {
    const AddComponent = plugin.add;
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
          <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
            <AddComponent
              onComplete={() => {
                setAdding(null);
                refreshSources();
              }}
              onCancel={() => setAdding(null)}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
        {/* Header */}
        <div className="flex items-end justify-between mb-8">
          <div>
            <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
              Sources
            </h1>
            <p className="mt-1.5 text-[14px] text-muted-foreground">
              Connected tool providers in this workspace.
            </p>
          </div>
          <div className="flex gap-2">
            {sourcePlugins.map((p) => (
              <button
                key={p.key}
                onClick={() => setAdding(p.key)}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
                  <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                Add {p.label}
              </button>
            ))}
          </div>
        </div>

        {Result.match(sources, {
          onInitial: () => (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ),
          onFailure: () => (
            <p className="text-sm text-destructive">Failed to load sources</p>
          ),
          onSuccess: ({ value }) =>
            value.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground mb-4">
                  <svg viewBox="0 0 24 24" fill="none" className="size-5">
                    <path d="M12 6v12M6 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </div>
                <p className="text-[14px] font-medium text-foreground/70 mb-1">
                  No sources yet
                </p>
                <p className="text-[13px] text-muted-foreground/60 mb-5">
                  Add a source to get started.
                </p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {value.map((s) => (
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
                          <path d="M8 5v6M5 8h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                        </svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="truncate text-sm font-semibold text-foreground">
                            {s.name}
                          </div>
                          <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
                            {s.kind}
                          </span>
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {s.id}
                        </div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            ),
        })}
      </div>
    </div>
  );
}

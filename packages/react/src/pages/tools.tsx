import { useAtomValue, Result } from "@effect-atom/atom-react";
import { toolsAtom } from "../api/atoms";
import { useScope } from "../hooks/use-scope";
import { Badge } from "../components/badge";

export function ToolsPage() {
  const scopeId = useScope();
  const tools = useAtomValue(toolsAtom(scopeId));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
        {/* Header */}
        <div className="flex items-end justify-between mb-8">
          <div>
            <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
              Tools
            </h1>
            <p className="mt-1.5 text-[14px] text-muted-foreground">
              All registered tools across your connected sources.
            </p>
          </div>
        </div>

        {Result.match(tools, {
          onInitial: () => <p className="text-sm text-muted-foreground">Loading tools…</p>,
          onFailure: () => <p className="text-sm text-destructive">Failed to load tools</p>,
          onSuccess: ({ value }) =>
            value.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground mb-4">
                  <svg viewBox="0 0 16 16" className="size-5">
                    <path
                      d="M4 2h8l1 3H3l1-3zM3 6h10v8H3V6z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    />
                  </svg>
                </div>
                <p className="text-[14px] font-medium text-foreground/70 mb-1">
                  No tools registered
                </p>
                <p className="text-[13px] text-muted-foreground/60">
                  Add a source to start discovering tools.
                </p>
              </div>
            ) : (
              <div className="grid gap-2">
                {value.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-start justify-between gap-3 rounded-xl border border-border bg-card px-5 py-3.5 transition-colors hover:border-primary/25 hover:bg-card/90"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-foreground truncate font-mono">
                        {t.name}
                      </p>
                      {t.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                          {t.description}
                        </p>
                      )}
                    </div>
                    <Badge variant="secondary">{t.sourceId}</Badge>
                  </div>
                ))}
              </div>
            ),
        })}
      </div>
    </div>
  );
}

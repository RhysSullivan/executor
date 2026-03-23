import { useSources } from "@executor/react";
import { LoadableBlock } from "../components/loadable";
import { Badge } from "../components/ui/badge";
import { SourcePluginsResetState } from "../components/source-plugins-reset-state";

export function HomePage() {
  const sources = useSources();

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
        <div className="rounded-3xl border border-border bg-card p-8">
          <div className="inline-flex rounded-full border border-border bg-muted px-3 py-1 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
            Sources
          </div>
          <h1 className="mt-5 font-display text-3xl tracking-tight text-foreground lg:text-4xl">
            Source plugins have been removed from the product shell
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            The built-in OpenAPI, GraphQL, MCP, and Google Discovery flows are
            intentionally stripped out. This leaves the workspace UI in a clean
            slate state while the plugin registration model is rebuilt.
          </p>
        </div>

        <div className="mt-8">
          <LoadableBlock loadable={sources} loading="Loading sources...">
            {(items) =>
              items.length === 0 ? (
                <SourcePluginsResetState
                  title="No registered source plugins"
                  message="No source plugins are registered in this build, so new sources cannot be added from the UI yet."
                />
              ) : (
                <div className="grid gap-3">
                  {items.map((source) => (
                    <div
                      key={source.id}
                      className="rounded-2xl border border-border bg-card px-5 py-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-foreground">
                            {source.name}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {source.endpoint}
                          </div>
                        </div>
                        <Badge
                          variant={
                            source.status === "connected"
                              ? "default"
                              : source.status === "error"
                                ? "destructive"
                                : "muted"
                          }
                        >
                          {source.status}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )
            }
          </LoadableBlock>
        </div>
      </div>
    </div>
  );
}

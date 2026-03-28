import { Link } from "@tanstack/react-router";
import { useSources } from "@executor/react";
import { sourcePluginsIndexPath } from "@executor/react/plugins";
import { LoadableBlock } from "../components/loadable";
import { LocalMcpInstallCard } from "../components/local-mcp-install-card";
import { SourceFavicon } from "../components/source-favicon";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { IconSources, IconPlus } from "../components/icons";
import {
  getSourceFrontendPaths,
} from "../plugins";

const statusVariant = (status: string) =>
  status === "connected"
    ? "default" as const
    : status === "error"
      ? "destructive" as const
      : "muted" as const;

export function HomePage() {
  const sources = useSources();

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
          <Link to={sourcePluginsIndexPath}>
            <Button size="sm">
              <IconPlus className="size-3.5" />
              Add source
            </Button>
          </Link>
        </div>

        <LocalMcpInstallCard className="mb-8" />

        {/* Source list */}
        <LoadableBlock loadable={sources} loading="Loading sources...">
          {(items) =>
            !Array.isArray(items) ? (
              <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-5 py-4 text-sm text-destructive">
                Sources returned an unexpected payload.
              </div>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground mb-4">
                  <IconSources className="size-5" />
                </div>
                <p className="text-[14px] font-medium text-foreground/70 mb-1">
                  No sources yet
                </p>
                <p className="text-[13px] text-muted-foreground/60 mb-5">
                  Add a source to get started.
                </p>
                <Link to={sourcePluginsIndexPath}>
                  <Button size="sm">
                    <IconPlus className="size-3.5" />
                    Add source
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((source) => {
                  const paths = getSourceFrontendPaths(source.kind);
                  const card = (
                    <div className="flex h-full flex-col rounded-2xl border border-border bg-card px-5 py-4 transition-colors hover:border-primary/25 hover:bg-card/90">
                      <div className="flex items-start gap-3">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <SourceFavicon source={source} className="size-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <div className="truncate text-sm font-semibold text-foreground">
                              {source.name}
                            </div>
                            <Badge variant={statusVariant(source.status)} className="shrink-0">
                              {source.status}
                            </Badge>
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {source.kind}
                          </div>
                        </div>
                      </div>
                    </div>
                  );

                  if (!paths) {
                    return (
                      <div key={source.id}>
                        {card}
                      </div>
                    );
                  }

                  return (
                    <Link
                      key={source.id}
                      to={paths.detail(source.id)}
                      search={{ tab: "model" }}
                    >
                      {card}
                    </Link>
                  );
                })}
              </div>
            )
          }
        </LoadableBlock>
      </div>
    </div>
  );
}

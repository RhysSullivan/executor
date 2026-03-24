import { Link } from "@tanstack/react-router";
import { useSources } from "@executor/react";
import { sourcePluginsIndexPath } from "@executor/react/source-plugins";
import { LoadableBlock } from "../components/loadable";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { SourcePluginsResetState } from "../components/source-plugins-reset-state";
import {
  getSourceFrontendPaths,
  registeredSourceFrontendTypes,
} from "../source-plugins";

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
            Source plugins now own source-specific product behavior
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            Add, edit, inspect, and authorize sources through plugin-owned UI and
            API surfaces. The core app stays generic while each plugin carries its
            own transport, auth, and storage behavior.
          </p>
          {registeredSourceFrontendTypes.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2">
              {registeredSourceFrontendTypes.map((definition) => (
                <Badge key={definition.key} variant="outline">
                  {definition.displayName}
                </Badge>
              ))}
            </div>
          )}
        </div>

        <div className="mt-8">
          <LoadableBlock loadable={sources} loading="Loading sources...">
            {(items) =>
              !Array.isArray(items) ? (
                <SourcePluginsResetState
                  title="Unexpected sources payload"
                  message="The sources list returned data in an unexpected shape."
                />
              ) : items.length === 0 ? (
                <SourcePluginsResetState
                  title="No sources connected yet"
                  message="Use the add flow to connect an OpenAPI, GraphQL, MCP, or Google Discovery source through its plugin-owned surface."
                  action={(
                    <Link to={sourcePluginsIndexPath}>
                      <Button size="sm" variant="outline">
                        Add Source
                      </Button>
                    </Link>
                  )}
                />
              ) : (
                <div className="grid gap-3">
                  {items.map((source) => {
                    const paths = getSourceFrontendPaths(source.kind);
                    const card = (
                      <div className="rounded-2xl border border-border bg-card px-5 py-4 transition-colors hover:border-primary/25 hover:bg-card/90">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-foreground">
                              {source.name}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {source.kind}
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
    </div>
  );
}

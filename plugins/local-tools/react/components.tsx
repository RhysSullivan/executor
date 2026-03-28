import { startTransition, type ReactNode } from "react";
import type {
  Source,
} from "@executor/react";
import {
  useSource,
  useSources,
} from "@executor/react";
import {
  SourceToolExplorer,
  parseSourceToolExplorerSearch,
  useSourcePluginNavigation,
  useSourcePluginRouteParams,
  useSourcePluginSearch,
  type SourceToolExplorerSearch,
} from "@executor/react/plugins";

const LOCAL_TOOLS_SOURCE_KIND = "local-tools";

const localToolsSummary = (
  <div className="text-xs text-muted-foreground">
    File-backed tools loaded from <code className="rounded bg-muted px-1 py-0.5 font-mono">.executor/tools</code>.
    Restart the executor session after adding the first local tool so the source is provisioned.
  </div>
);

function LocalToolsSourceRoute(props: {
  children: (source: Source) => ReactNode;
}) {
  const params = useSourcePluginRouteParams<{ sourceId?: string }>();
  const sourceId = typeof params.sourceId === "string" ? params.sourceId : null;
  const source = useSource(sourceId ?? "");

  if (sourceId === null || source.status === "error") {
    return (
      <div className="px-6 py-8 text-sm text-destructive">
        This local tools source is unavailable.
      </div>
    );
  }

  if (source.status === "loading") {
    return (
      <div className="px-6 py-8 text-sm text-muted-foreground">
        Loading source...
      </div>
    );
  }

  if (source.data.kind !== LOCAL_TOOLS_SOURCE_KIND) {
    return (
      <div className="px-6 py-8 text-sm text-destructive">
        Expected a <code className="rounded bg-muted px-1 py-0.5 font-mono">local-tools</code> source,
        but received <code className="rounded bg-muted px-1 py-0.5 font-mono">{source.data.kind}</code>.
      </div>
    );
  }

  return props.children(source.data);
}

function LocalToolsSourceDetailPage(props: {
  source: Source;
}) {
  const navigation = useSourcePluginNavigation();
  const search = parseSourceToolExplorerSearch(
    useSourcePluginSearch(),
  ) satisfies SourceToolExplorerSearch;
  const tab = search.tab === "discover" ? "discover" : "model";
  const query = search.query ?? "";

  return (
    <SourceToolExplorer
      sourceId={props.source.id}
      title={props.source.name}
      kind={props.source.kind}
      search={search}
      navigate={(next) =>
        navigation.updateSearch({
          tab: next.tab ?? tab,
          ...(next.tool !== undefined
            ? { tool: next.tool || undefined }
            : { tool: search.tool }),
          ...(next.query !== undefined
            ? { query: next.query || undefined }
            : { query }),
        })}
      summary={localToolsSummary}
    />
  );
}

export function LocalToolsAddPage() {
  const sources = useSources();
  const navigation = useSourcePluginNavigation();

  if (sources.status === "loading") {
    return (
      <div className="px-6 py-8 text-sm text-muted-foreground">
        Loading sources...
      </div>
    );
  }

  if (sources.status === "error") {
    return (
      <div className="px-6 py-8 text-sm text-destructive">
        Failed loading sources.
      </div>
    );
  }

  const localToolsSource = sources.data.find(
    (source) => source.kind === LOCAL_TOOLS_SOURCE_KIND,
  ) ?? null;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="rounded-2xl border border-border bg-card p-6">
        <h1 className="font-display text-2xl tracking-tight text-foreground">
          Local Tools
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Promote file-backed tools in <code className="rounded bg-muted px-1 py-0.5 font-mono">.executor/tools</code>
          {" "}into a first-class source with inspection and discovery.
        </p>

        <div className="mt-6 rounded-xl border border-border/70 bg-background/60 p-4 text-sm text-muted-foreground">
          <p>
            The source is provisioned automatically when the executor session starts and finds
            local tool files in <code className="rounded bg-muted px-1 py-0.5 font-mono">.executor/tools</code>.
          </p>
          <p className="mt-3">
            Existing tool path behavior is preserved, so a file like
            {" "}<code className="rounded bg-muted px-1 py-0.5 font-mono">.executor/tools/demo.ts</code>
            {" "}still appears as <code className="rounded bg-muted px-1 py-0.5 font-mono">tools.demo(...)</code>.
          </p>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {localToolsSource ? (
            <button
              type="button"
              onClick={() => {
                startTransition(() => {
                  void navigation.detail(localToolsSource.id, {
                    tab: "model",
                  });
                });
              }}
              className="inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Open Local Tools Source
            </button>
          ) : (
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-4 py-2.5 text-sm text-amber-700">
              No local tools source is active yet. Create a tool in
              {" "}<code className="rounded bg-muted px-1 py-0.5 font-mono">.executor/tools</code>
              {" "}and restart the executor session.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function LocalToolsDetailRoute() {
  return (
    <LocalToolsSourceRoute>
      {(source) => <LocalToolsSourceDetailPage source={source} />}
    </LocalToolsSourceRoute>
  );
}

import { Suspense } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { SourcePlugin } from "@executor/react";
import { useAtomRefresh, sourcesAtom } from "@executor/react";
import { useScope } from "../lib/use-scope";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";
import { mcpSourcePlugin } from "@executor/plugin-mcp/react";
import { googleDiscoverySourcePlugin } from "@executor/plugin-google-discovery/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";

// ---------------------------------------------------------------------------
// Registered source plugins
// ---------------------------------------------------------------------------

const sourcePlugins: SourcePlugin[] = [
  openApiSourcePlugin,
  mcpSourcePlugin,
  googleDiscoverySourcePlugin,
  graphqlSourcePlugin,
];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SourcesAddPage(props: {
  pluginKey: string;
  url?: string;
  preset?: string;
}) {
  const { pluginKey, url, preset } = props;
  const scopeId = useScope();
  const refreshSources = useAtomRefresh(sourcesAtom(scopeId));
  const navigate = useNavigate();

  const plugin = sourcePlugins.find((p) => p.key === pluginKey);

  if (!plugin) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20">
            <p className="text-[14px] font-medium text-foreground/70 mb-1">
              Unknown source type: {pluginKey}
            </p>
            <p className="text-[13px] text-muted-foreground/60 mb-5">
              This source plugin is not registered.
            </p>
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Back to sources
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const AddComponent = plugin.add;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
        <Suspense
          fallback={
            <p className="text-sm text-muted-foreground">Loading…</p>
          }
        >
          <AddComponent
            initialUrl={url}
            initialPreset={preset}
            onComplete={() => {
              refreshSources();
              void navigate({ to: "/" });
            }}
            onCancel={() => {
              void navigate({ to: "/" });
            }}
          />
        </Suspense>
      </div>
    </div>
  );
}

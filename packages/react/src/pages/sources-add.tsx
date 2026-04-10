import { Suspense } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { SourcePlugin } from "../plugins/source-plugin";
import { useAtomRefresh } from "@effect-atom/atom-react";
import { sourcesAtom } from "../api/atoms";
import { useScope } from "../hooks/use-scope";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SourcesAddPage(props: {
  pluginKey: string;
  url?: string;
  preset?: string;
  namespace?: string;
  sourcePlugins: readonly SourcePlugin[];
}) {
  const { pluginKey, url, preset, namespace, sourcePlugins } = props;
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
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
          <AddComponent
            initialUrl={url}
            initialPreset={preset}
            initialNamespace={namespace}
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

import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { ToolsView } from "@/components/tools/view";
import { useSearchParams } from "@/lib/router";

export const Route = createFileRoute("/tools")({
  component: ToolsPage,
});

function ToolsPage() {
  const [searchParams] = useSearchParams();
  const source = searchParams.get("source");
  const tab = searchParams.get("tab");

  return (
    <AppShell>
      <div className="h-full min-h-0">
        <ToolsView key={`${tab ?? "catalog"}:${source ?? "all"}`} initialSource={source} initialTab={tab} />
      </div>
    </AppShell>
  );
}

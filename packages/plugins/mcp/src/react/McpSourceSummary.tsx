import { Badge } from "@executor/react/components/badge";

// ---------------------------------------------------------------------------
// MCP Source Summary — shown in the source list
// ---------------------------------------------------------------------------

export default function McpSourceSummary({ sourceId }: { readonly sourceId: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant="secondary" className="text-xs">
        MCP
      </Badge>
      <span className="text-sm text-muted-foreground">{sourceId}</span>
    </span>
  );
}

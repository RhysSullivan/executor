import { Badge } from "@executor/react/components/badge";

export default function GoogleDiscoverySourceSummary({ sourceId }: { readonly sourceId: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant="secondary" className="text-xs">
        Google
      </Badge>
      <span className="text-sm text-muted-foreground">{sourceId}</span>
    </span>
  );
}

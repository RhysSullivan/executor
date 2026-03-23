import { Link } from "@tanstack/react-router";
import { SourcePluginsResetState } from "../components/source-plugins-reset-state";
import { Button } from "../components/ui/button";

type SourceRouteSearch = {
  tab: "model" | "discover";
  tool?: string;
  query?: string;
};

export function SourceDetailPage(_input: {
  sourceId: string;
  search: SourceRouteSearch;
  navigate: unknown;
}) {
  return (
    <SourcePluginsResetState
      title="Source detail is disabled"
      message="The source-specific detail experience was removed with the old built-in OpenAPI, GraphQL, MCP, and Google Discovery product wiring. This route remains only as a placeholder while plugin-backed detail modules are designed."
      action={(
        <Link to="/">
          <Button size="sm" variant="outline">
            Back to sources
          </Button>
        </Link>
      )}
    />
  );
}

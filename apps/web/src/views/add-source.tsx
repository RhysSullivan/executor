import { Link } from "@tanstack/react-router";
import { SourcePluginsResetState } from "../components/source-plugins-reset-state";
import { Button } from "../components/ui/button";

export function AddSourcePage() {
  return (
    <SourcePluginsResetState
      title="Add Source is intentionally blank"
      message="The previous OpenAPI, GraphQL, MCP, and Google Discovery source onboarding flows were removed so the product can be rebuilt around explicit source plugins."
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

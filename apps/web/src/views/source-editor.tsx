import { Link } from "@tanstack/react-router";
import { SourcePluginsResetState } from "../components/source-plugins-reset-state";
import { Button } from "../components/ui/button";

export function NewSourcePage() {
  return (
    <SourcePluginsResetState
      title="New source creation is disabled"
      message="The old source creation form was removed as part of the clean-slate plugin reset. New source creation will come back through registered plugin modules instead of hard-coded source kinds."
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

export function EditSourcePage(_input: {
  sourceId: string;
}) {
  return (
    <SourcePluginsResetState
      title="Source editing is disabled"
      message="The previous source editor contained hard-coded OpenAPI, GraphQL, MCP, and Google Discovery behavior. That editor has been removed so a plugin-defined editor surface can replace it."
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

import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";
import { SourcesAddPage } from "@executor/react/pages/sources-add";
import { openApiSourcePlugin } from "@executor/plugin-openapi/react";
import { mcpSourcePlugin } from "@executor/plugin-mcp/react";
import { googleDiscoverySourcePlugin } from "@executor/plugin-google-discovery/react";
import { graphqlSourcePlugin } from "@executor/plugin-graphql/react";

const sourcePlugins = [
  openApiSourcePlugin,
  mcpSourcePlugin,
  googleDiscoverySourcePlugin,
  graphqlSourcePlugin,
];

const SearchParams = Schema.standardSchemaV1(
  Schema.Struct({
    url: Schema.optional(Schema.String),
    preset: Schema.optional(Schema.String),
    namespace: Schema.optional(Schema.String),
  }),
);

export const Route = createFileRoute("/sources/add/$pluginKey")({
  validateSearch: SearchParams,
  component: () => {
    const { pluginKey } = Route.useParams();
    const { url, preset, namespace } = Route.useSearch();
    return (
      <SourcesAddPage
        pluginKey={pluginKey}
        url={url}
        preset={preset}
        namespace={namespace}
        sourcePlugins={sourcePlugins}
      />
    );
  },
});

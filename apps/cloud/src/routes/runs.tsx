import { Schema } from "effect";
import { createFileRoute } from "@tanstack/react-router";
import { RunsPage, type RunsSearch } from "@executor/react/pages/runs";

const RunsSearchSchema = Schema.standardSchemaV1(
  Schema.Struct({
    executionId: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    trigger: Schema.optional(Schema.String),
    tool: Schema.optional(Schema.String),
    range: Schema.optional(Schema.String),
    from: Schema.optional(Schema.String),
    to: Schema.optional(Schema.String),
    code: Schema.optional(Schema.String),
    live: Schema.optional(Schema.String),
    sort: Schema.optional(Schema.String),
    elicitation: Schema.optional(Schema.String),
  }),
);

export const Route = createFileRoute("/runs")({
  validateSearch: RunsSearchSchema,
  component: () => <RunsPage search={Route.useSearch() as RunsSearch} />,
});

import { createFileRoute } from "@tanstack/react-router";
import { SourcesListPage } from "@executor/react/pages/sources";

export const Route = createFileRoute("/sources/")({
  component: SourcesListPage,
});

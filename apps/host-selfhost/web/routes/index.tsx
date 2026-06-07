import { createFileRoute } from "@tanstack/react-router";
import { IntegrationsPage } from "@executor-js/react/pages/integrations";

export const Route = createFileRoute("/")({
  component: IntegrationsPage,
});

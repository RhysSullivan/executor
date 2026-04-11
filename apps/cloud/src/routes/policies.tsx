import { createFileRoute } from "@tanstack/react-router";
import { PoliciesPage } from "@executor/plugin-policies/react";

export const Route = createFileRoute("/policies")({
  component: PoliciesPage,
});

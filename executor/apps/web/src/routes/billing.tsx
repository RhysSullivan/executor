import { Navigate, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/billing")({
  component: BillingRedirect,
});

function BillingRedirect() {
  return <Navigate to="/organization" search={{ tab: "billing" }} replace />;
}

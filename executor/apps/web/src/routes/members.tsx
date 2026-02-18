import { Navigate, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/members")({
  component: MembersRedirect,
});

function MembersRedirect() {
  return <Navigate to="/organization" search={{ tab: "members" }} replace />;
}

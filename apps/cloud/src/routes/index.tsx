import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { useAuth } from "../web/auth";

// ---------------------------------------------------------------------------
// `/` — lands the user on their active organization's scoped URL.
//
// AuthGate in __root already guarantees we only mount this when the user is
// authenticated and has an org, so we can assume `auth.organization` is set.
// ---------------------------------------------------------------------------

export const Route = createFileRoute("/")({
  component: IndexRedirect,
});

function IndexRedirect() {
  const auth = useAuth();
  const navigate = useNavigate();
  const slug = auth.status === "authenticated" ? auth.organization?.slug ?? null : null;

  useEffect(() => {
    if (!slug) return;
    void navigate({ to: "/$org", params: { org: slug }, replace: true });
  }, [slug, navigate]);

  return (
    <div className="flex flex-1 items-center justify-center">
      <p className="text-sm text-muted-foreground">Loading…</p>
    </div>
  );
}

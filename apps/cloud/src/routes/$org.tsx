import { useEffect } from "react";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useAtomValue, useAtomSet, Result } from "@effect-atom/atom-react";

import { organizationsAtom, switchOrganization, useAuth } from "../web/auth";

// ---------------------------------------------------------------------------
// /$org layout — scopes everything under an organization slug.
//
// The session cookie is the server-side source of truth for which org is
// active. The slug in the URL is the *client-side* source of truth. When
// they disagree we reconcile by calling switchOrganization (which mutates
// the cookie) and reloading. Keeping the URL authoritative means links,
// bookmarks and copy-pasted addresses all work without the user having to
// manually flip orgs.
// ---------------------------------------------------------------------------

export const Route = createFileRoute("/$org")({
  component: OrgLayout,
});

function OrgLayout() {
  const { org: slug } = Route.useParams();
  const auth = useAuth();
  const organizationsResult = useAtomValue(organizationsAtom);
  const doSwitch = useAtomSet(switchOrganization, { mode: "promiseExit" });

  const activeSlug = auth.status === "authenticated" ? auth.organization?.slug ?? null : null;
  const slugMatches = activeSlug === slug;

  const targetOrg = Result.match(organizationsResult, {
    onInitial: () => null,
    onFailure: () => null,
    onSuccess: ({ value }) => value.organizations.find((o) => o.slug === slug) ?? null,
  });

  useEffect(() => {
    if (slugMatches) return;
    if (!targetOrg) return;
    let cancelled = false;
    void doSwitch({ payload: { organizationId: targetOrg.id } }).then((exit) => {
      if (cancelled) return;
      if (exit._tag === "Success") window.location.reload();
    });
    return () => {
      cancelled = true;
    };
  }, [slugMatches, targetOrg, doSwitch]);

  if (slugMatches) {
    return <Outlet />;
  }

  // Mid-switch or looking up whether the user is a member of :org.
  const lookupPending = Result.match(organizationsResult, {
    onInitial: () => true,
    onFailure: () => false,
    onSuccess: () => false,
  });

  if (lookupPending || targetOrg) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading organization…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="max-w-sm text-center">
        <p className="font-display text-2xl text-foreground">Organization not found</p>
        <p className="mt-2 text-sm text-muted-foreground">
          You don't have access to <code className="font-mono">{slug}</code>, or it doesn't
          exist.
        </p>
      </div>
    </div>
  );
}

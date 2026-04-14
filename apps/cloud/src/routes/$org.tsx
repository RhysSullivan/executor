import { useEffect } from "react";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useAtomValue, useAtomSet, Result } from "@effect-atom/atom-react";
import { setOrgSlug } from "@executor/react/api/base-url";

import { organizationsAtom, switchOrganization, useAuth } from "../web/auth";

// ---------------------------------------------------------------------------
// /$org layout — scopes everything under an organization slug.
//
// The slug in the URL is the source of truth: `setOrgSlug` tells the API
// client to pin every request to `/api/o/:slug/*` and the server resolves
// the org from that path independent of the session cookie. Bookmarks,
// copy-pasted links and cross-tab navigation all work without first having
// to flip the cookie.
//
// We still call `switchOrganization` as a best-effort side-channel so that
// flows which read the cookie directly (the WorkOS user portal, Autumn
// billing redirects) see the same active org. That reconcile is no longer
// a render-gate though — children mount immediately.
// ---------------------------------------------------------------------------

export const Route = createFileRoute("/$org")({
  component: OrgLayout,
});

function OrgLayout() {
  const { org: slug } = Route.useParams();
  const auth = useAuth();
  const organizationsResult = useAtomValue(organizationsAtom);
  const doSwitch = useAtomSet(switchOrganization, { mode: "promiseExit" });

  // Pin API requests to this slug before any child atoms fetch. Writing to
  // a module-level ref during render is safe (idempotent) and avoids a
  // first-render window where the client would otherwise hit `/api/*`
  // unscoped and get authorized against the cookie instead.
  setOrgSlug(slug);

  const activeSlug = auth.status === "authenticated" ? auth.organization?.slug ?? null : null;
  const cookieMatches = activeSlug === slug;

  const targetOrg = Result.match(organizationsResult, {
    onInitial: () => null,
    onFailure: () => null,
    onSuccess: ({ value }) => value.organizations.find((o) => o.slug === slug) ?? null,
  });

  // Best-effort cookie reconcile — no longer a render gate. If the switch
  // fails or is slow, the API still works because requests are URL-pinned.
  useEffect(() => {
    if (cookieMatches) return;
    if (!targetOrg) return;
    let cancelled = false;
    void doSwitch({ payload: { organizationId: targetOrg.id } }).then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [cookieMatches, targetOrg, doSwitch]);

  // We still need to know whether the user is actually a member of this
  // slug: if the org list has resolved and the slug isn't in it, show the
  // not-found card instead of mounting children that'll 403.
  const orgKnown = Result.match(organizationsResult, {
    onInitial: () => true, // still loading — optimistically mount
    onFailure: () => true, // org list failed — let children try
    onSuccess: () => targetOrg !== null || cookieMatches,
  });

  if (orgKnown) {
    return <Outlet />;
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

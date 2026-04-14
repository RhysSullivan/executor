import { useAtomRefresh } from "@effect-atom/atom-react";
import { Button } from "@executor/react/components/button";

import { AUTH_PATHS } from "../../auth/api";
import { authAtom, useAuth } from "../auth";
import {
  CreateOrganizationFields,
  useCreateOrganizationForm,
} from "../components/create-organization-form";

export const OnboardingPage = () => {
  const auth = useAuth();
  const refreshAuth = useAtomRefresh(authAtom);

  const suggestedName =
    auth.status === "authenticated" &&
    auth.user.name != null &&
    auth.user.name.trim() !== ""
      ? `${auth.user.name}'s Organization`
      : "";

  const form = useCreateOrganizationForm({
    defaultName: suggestedName,
    // On success: the server set a new cookie with the new org. Hard-
    // navigate to the new org's scoped URL so we land directly on the
    // `/${slug}/` route rather than bouncing through `/` and an extra
    // AuthGate cycle.
    // On failure: the server may have cleared the cookie because the
    // current session was too stale to attach the new org. Refetch /me
    // so AuthGate can route to LoginPage if that's the case.
    onSuccess: (org) => window.location.assign(`/${org.slug}/`),
    onFailure: () => refreshAuth(),
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="mx-auto flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="font-serif text-3xl">Create your organization</h1>
          <p className="text-sm text-muted-foreground">
            Organizations group your sources, secrets, and teammates. You can invite others once
            it's set up.
          </p>
        </div>

        <CreateOrganizationFields
          name={form.name}
          onNameChange={(name) => {
            form.setName(name);
            if (form.error) form.setError(null);
          }}
          error={form.error}
          onSubmit={() => void form.submit()}
        />

        <div className="flex items-center justify-between gap-3">
          {/* oxlint-disable-next-line react/forbid-elements */}
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={async () => {
              await fetch(AUTH_PATHS.logout, { method: "POST" });
              window.location.href = "/";
            }}
          >
            Sign out
          </button>
          <Button
            size="sm"
            onClick={() => void form.submit()}
            disabled={!form.canSubmit || form.creating}
          >
            {form.creating ? "Creating…" : "Create organization"}
          </Button>
        </div>
      </div>
    </div>
  );
};

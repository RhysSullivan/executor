"use client";

import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { convexApi } from "@/lib/convex-api";
import { useSession } from "@/lib/session-context";

export function OnboardingView() {
  const navigate = useNavigate();
  const createOrganization = useMutation(convexApi.organizations.create);
  const {
    isSignedInToWorkos,
    organizations,
    organizationsLoading,
    switchWorkspace,
  } = useSession();

  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError("Organization name must be at least 2 characters.");
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const result = await createOrganization({ name: trimmed });
      switchWorkspace(result.workspace.id);
      navigate("/", { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create organization");
    } finally {
      setCreating(false);
    }
  };

  if (!isSignedInToWorkos) {
    return (
      <div className="min-h-[70vh] grid place-items-center">
        <Card className="w-full max-w-xl border-border">
          <CardHeader>
            <CardTitle>Sign in required</CardTitle>
            <CardDescription>
              You need to sign in before setting up an organization.
            </CardDescription>
          </CardHeader>
          <CardFooter className="justify-between gap-2">
            <Button asChild variant="outline">
              <Link to="/">Back</Link>
            </Button>
            <Button asChild>
              <Link to="/sign-in" reloadDocument>Sign in</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (!organizationsLoading && organizations.length > 0) {
    return (
      <div className="min-h-[70vh] grid place-items-center">
        <Card className="w-full max-w-xl border-border">
          <CardHeader>
            <CardTitle>Organization ready</CardTitle>
            <CardDescription>
              Your account is already linked to an organization.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button asChild className="w-full">
              <Link to="/">Continue to dashboard</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-[80vh] grid place-items-center">
      <Card className="w-full max-w-xl border-border">
        <CardHeader>
          <div className="mb-2 inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-muted">
            <Building2 className="h-4 w-4 text-muted-foreground" />
          </div>
          <CardTitle>Name your organization</CardTitle>
          <CardDescription>
            This is your team space. You can invite members and create more workspaces later.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-2">
            <Input
              value={name}
              onChange={(event) => {
                setError(null);
                setName(event.target.value);
              }}
              placeholder="Acme"
              maxLength={64}
              autoFocus
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </CardContent>
          <CardFooter className="justify-end gap-2">
            <Button asChild variant="outline" disabled={creating}>
              <Link to="/sign-out" reloadDocument>Sign out</Link>
            </Button>
            <Button type="submit" disabled={creating}>
              {creating ? "Creating..." : "Continue"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}

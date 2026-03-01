"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useAtomSet, useAtomValue } from "@effect-atom/atom-react";
import type { Organization, Workspace } from "@executor-v2/schema";

import { useWorkspace } from "../../lib/hooks/use-workspace";
import {
  organizationsState,
  upsertOrganization,
  upsertWorkspace,
  toOrganizationUpsertPayload,
  toWorkspaceUpsertPayload,
  workspacesState,
} from "../../lib/control-plane/atoms";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { matchState } from "../shared/match-state";
import { PageHeader } from "../shared/page-header";
import { StatusMessage } from "../shared/status-message";

type OrganizationForm = {
  id: string;
  slug: string;
  name: string;
  status: Organization["status"];
};

type WorkspaceForm = {
  id: string;
  name: string;
  organizationId: string;
};

const organizationStatusOptions: ReadonlyArray<Organization["status"]> = [
  "active",
  "suspended",
  "archived",
];

const defaultOrganizationForm = (): OrganizationForm => ({
  id: "",
  slug: "",
  name: "",
  status: "active",
});

const defaultWorkspaceForm = (): WorkspaceForm => ({
  id: "",
  name: "",
  organizationId: "",
});

const createOrganizationId = (): Organization["id"] =>
  `org_${crypto.randomUUID()}` as Organization["id"];

const createWorkspaceId = (): Workspace["id"] =>
  `ws_${crypto.randomUUID()}` as Workspace["id"];

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : fallback;

const organizationStatusVariant = (
  status: Organization["status"],
): "approved" | "pending" | "denied" | "outline" => {
  if (status === "active") {
    return "approved";
  }
  if (status === "suspended") {
    return "pending";
  }
  return "denied";
};

const statusVariant = (message: string | null): "info" | "error" => {
  return message?.toLowerCase().includes("failed") ? "error" : "info";
};

export default function SettingsView() {
  const { workspaceId, setWorkspaceId } = useWorkspace();

  const organizations = useAtomValue(organizationsState);
  const workspaces = useAtomValue(workspacesState);
  const runUpsertOrganization = useAtomSet(upsertOrganization, { mode: "promise" });
  const runUpsertWorkspace = useAtomSet(upsertWorkspace, { mode: "promise" });

  const [organizationForm, setOrganizationForm] = useState<OrganizationForm>(defaultOrganizationForm);
  const [workspaceForm, setWorkspaceForm] = useState<WorkspaceForm>(defaultWorkspaceForm);
  const [organizationStatusText, setOrganizationStatusText] = useState<string | null>(null);
  const [workspaceStatusText, setWorkspaceStatusText] = useState<string | null>(null);

  const organizationsLoading = organizations.state === "loading";
  const workspacesLoading = workspaces.state === "loading";

  useEffect(() => {
    if (workspaceForm.name.trim().length > 0) {
      return;
    }

    const currentWorkspace = workspaces.items.find((workspace) => workspace.id === workspaceId);
    if (!currentWorkspace) {
      return;
    }

    setWorkspaceForm((current) => ({
      ...current,
      id: currentWorkspace.id,
      name: currentWorkspace.name,
      organizationId: currentWorkspace.organizationId,
    }));
  }, [workspaceId, workspaceForm.name, workspaces.items]);

  useEffect(() => {
    if (organizationForm.id.trim().length > 0) {
      return;
    }

    const currentWorkspace = workspaces.items.find((workspace) => workspace.id === workspaceId);
    if (!currentWorkspace) {
      return;
    }

    const currentOrganization = organizations.items.find(
      (organization) => organization.id === currentWorkspace.organizationId,
    );
    if (!currentOrganization) {
      return;
    }

    setOrganizationForm({
      id: currentOrganization.id,
      slug: currentOrganization.slug,
      name: currentOrganization.name,
      status: currentOrganization.status,
    });
  }, [organizationForm.id, organizations.items, workspaceId, workspaces.items]);

  const handleUpsertOrganization = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const slug = organizationForm.slug.trim();
    const name = organizationForm.name.trim();
    const inputId = organizationForm.id.trim();
    const organizationId = inputId.length > 0
      ? (inputId as Organization["id"])
      : createOrganizationId();

    if (slug.length === 0 || name.length === 0) {
      setOrganizationStatusText("Organization slug and name are required.");
      return;
    }

    const payload = toOrganizationUpsertPayload({
      id: organizationId,
      slug,
      name,
      status: organizationForm.status,
    });

    void runUpsertOrganization({ payload })
      .then((organization) => {
        setOrganizationStatusText(`Saved organization ${organization.slug}.`);
        setOrganizationForm({
          id: organization.id,
          slug: organization.slug,
          name: organization.name,
          status: organization.status,
        });
      })
      .catch((cause) => {
        setOrganizationStatusText(errorMessage(cause, "Organization save failed."));
      });
  };

  const handleUpsertWorkspace = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const name = workspaceForm.name.trim();
    const inputId = workspaceForm.id.trim();
    const organizationId = workspaceForm.organizationId.trim();
    const workspaceId = inputId.length > 0
      ? (inputId as Workspace["id"])
      : createWorkspaceId();

    if (name.length === 0) {
      setWorkspaceStatusText("Workspace name is required.");
      return;
    }

    if (organizationId.length === 0) {
      setWorkspaceStatusText("Workspace organization is required.");
      return;
    }

    const payload = toWorkspaceUpsertPayload({
      id: workspaceId,
      name,
      organizationId: organizationId as Workspace["organizationId"],
    });

    void runUpsertWorkspace({ payload })
      .then((workspace) => {
        setWorkspaceStatusText(`Saved workspace ${workspace.name}.`);
        setWorkspaceForm({
          id: workspace.id,
          name: workspace.name,
          organizationId: workspace.organizationId,
        });
        setWorkspaceId(workspace.id);
      })
      .catch((cause) => {
        setWorkspaceStatusText(errorMessage(cause, "Workspace save failed."));
      });
  };

  const handleLoadOrganization = (organization: Organization) => {
    setOrganizationForm({
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      status: organization.status,
    });
    setOrganizationStatusText(`Loaded organization ${organization.slug}.`);
  };

  const handleLoadWorkspace = (workspace: Workspace) => {
    setWorkspaceForm({
      id: workspace.id,
      name: workspace.name,
      organizationId: workspace.organizationId,
    });
    setWorkspaceId(workspace.id);
    setWorkspaceStatusText(`Loaded workspace ${workspace.id}.`);
  };

  return (
    <section className="space-y-8">
      <PageHeader
        title="Settings"
        description="Manage organizations and workspaces in a single combined view."
      />

      <section className="space-y-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="border-border/70">
            <CardHeader className="pb-3">
              <CardTitle>Organization Profile</CardTitle>
              <CardDescription>
                Create and edit organization records used by workspace definitions.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <form className="space-y-3" onSubmit={handleUpsertOrganization}>
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="organization-id">
                    ID (optional)
                  </label>
                  <Input
                    id="organization-id"
                    value={organizationForm.id}
                    onChange={(event) =>
                      setOrganizationForm((current) => ({ ...current, id: event.target.value }))
                    }
                    placeholder="org_local"
                    disabled={organizationsLoading}
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="organization-slug">
                    Slug
                  </label>
                  <Input
                    id="organization-slug"
                    value={organizationForm.slug}
                    onChange={(event) =>
                      setOrganizationForm((current) => ({ ...current, slug: event.target.value }))
                    }
                    placeholder="acme"
                    required
                    disabled={organizationsLoading}
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="organization-name">
                    Name
                  </label>
                  <Input
                    id="organization-name"
                    value={organizationForm.name}
                    onChange={(event) =>
                      setOrganizationForm((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder="Acme"
                    required
                    disabled={organizationsLoading}
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="organization-status">
                    Status
                  </label>
                  <Select
                    id="organization-status"
                    value={organizationForm.status}
                    onChange={(event) =>
                      setOrganizationForm((current) => ({
                        ...current,
                        status: event.target.value as Organization["status"],
                      }))
                    }
                    disabled={organizationsLoading}
                  >
                    {organizationStatusOptions.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </Select>
                </div>

                <div className="flex gap-2">
                  <Button type="submit" disabled={organizationsLoading}>
                    Save Organization
                  </Button>
                </div>
              </form>

              <StatusMessage
                message={organizationStatusText}
                variant={statusVariant(organizationStatusText)}
                className="text-[13px]"
              />
            </CardContent>
          </Card>

          <Card className="border-border/70">
            <CardHeader className="pb-3">
              <CardTitle>Organizations</CardTitle>
              <CardDescription>Available organizations from the control plane.</CardDescription>
            </CardHeader>

            <CardContent className="space-y-3">
              {matchState(organizations, {
                loading: "Loading organizations...",
                empty: "No organizations yet.",
                ready: (organizationItems) => (
                  <>
                    {organizationItems.map((organization) => (
                      <div
                        key={organization.id}
                        className="rounded-lg border border-border bg-background/70 p-3"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 space-y-1">
                            <p className="truncate text-sm font-medium">{organization.name}</p>
                            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              <Badge variant={organizationStatusVariant(organization.status)}>{organization.status}</Badge>
                              <span className="break-all">{organization.slug}</span>
                              <span className="break-all">{organization.id}</span>
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              handleLoadOrganization(organization);
                            }}
                          >
                            Load
                          </Button>
                        </div>
                      </div>
                    ))}
                  </>
                ),
              })}
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="space-y-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <Card className="border-border/70">
            <CardHeader className="pb-3">
              <CardTitle>Workspace Profile</CardTitle>
              <CardDescription>
                Create or update workspace records scoped to an organization.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <form className="space-y-3" onSubmit={handleUpsertWorkspace}>
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="workspace-id">
                    ID (optional)
                  </label>
                  <Input
                    id="workspace-id"
                    value={workspaceForm.id}
                    onChange={(event) =>
                      setWorkspaceForm((current) => ({ ...current, id: event.target.value }))
                    }
                    placeholder="ws_local"
                    disabled={workspacesLoading}
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="workspace-name">
                    Name
                  </label>
                  <Input
                    id="workspace-name"
                    value={workspaceForm.name}
                    onChange={(event) =>
                      setWorkspaceForm((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder="Local Workspace"
                    required
                    disabled={workspacesLoading}
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground" htmlFor="workspace-organization-id">
                    Organization
                  </label>
                  <Select
                    id="workspace-organization-id"
                    value={workspaceForm.organizationId}
                    onChange={(event) =>
                      setWorkspaceForm((current) => ({
                        ...current,
                        organizationId: event.target.value,
                      }))
                    }
                    disabled={workspacesLoading}
                  >
                    <option value="">Select organization</option>
                    {organizations.items.map((organization) => (
                      <option key={organization.id} value={organization.id}>
                        {organization.name}
                      </option>
                    ))}
                  </Select>
                </div>

                <div className="flex gap-2">
                  <Button type="submit" disabled={workspacesLoading}>
                    Save Workspace
                  </Button>
                </div>
              </form>

              <StatusMessage
                message={workspaceStatusText}
                variant={statusVariant(workspaceStatusText)}
                className="text-[13px]"
              />
            </CardContent>
          </Card>

          <Card className="border-border/70">
            <CardHeader className="pb-3">
              <CardTitle>Workspaces</CardTitle>
              <CardDescription>Available workspaces from the control plane.</CardDescription>
            </CardHeader>

            <CardContent className="space-y-3">
              {matchState(workspaces, {
                loading: "Loading workspaces...",
                empty: "No workspaces yet.",
                ready: (workspaceItems) => (
                  <>
                    {workspaceItems.map((workspace) => (
                      <div
                        key={workspace.id}
                        className="rounded-lg border border-border bg-background/70 p-3"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 space-y-1">
                            <p className="truncate text-sm font-medium">{workspace.name}</p>
                            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              <span className="break-all">{workspace.id}</span>
                              <span className="break-all">org {workspace.organizationId}</span>
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              handleLoadWorkspace(workspace);
                            }}
                          >
                            Load
                          </Button>
                        </div>
                      </div>
                    ))}
                  </>
                ),
              })}
            </CardContent>
          </Card>
        </div>
      </section>
    </section>
  );
}

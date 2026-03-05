"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAtomSet, useAtomValue } from "@effect-atom/atom-react";
import type { Organization, Workspace } from "@executor-v2/schema";

import {
  organizationsState,
  toUpsertOrganizationRequest,
  toUpsertWorkspaceRequest,
  toOrganizationUpsertPayload,
  toWorkspaceUpsertPayload,
  upsertOrganization,
  upsertWorkspace,
  workspacesState,
} from "../../lib/control-plane/atoms";
import { useWorkspace } from "../../lib/hooks/use-workspace";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type StatusState = {
  message: string | null;
  variant: "info" | "error";
};

type OrganizationGroup = {
  organizationId: Organization["id"];
  label: string;
  workspaces: Array<Workspace>;
};

const defaultStatus = (): StatusState => ({ message: null, variant: "info" });

const createWorkspaceId = (): Workspace["id"] =>
  `ws_${crypto.randomUUID()}` as Workspace["id"];

const createOrganizationId = (): Organization["id"] =>
  `org_${crypto.randomUUID()}` as Organization["id"];

const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : fallback;

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/-{2,}/g, "-");

const CheckIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const PlusIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const ChevronsIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" fill="none" className={className}>
    <path d="M5 6l3-3 3 3M11 10l-3 3-3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function WorkspaceSelector() {
  const { workspaceId, setWorkspaceId } = useWorkspace();
  const organizations = useAtomValue(organizationsState);
  const workspaces = useAtomValue(workspacesState);
  const runUpsertOrganization = useAtomSet(upsertOrganization, { mode: "promise" });
  const runUpsertWorkspace = useAtomSet(upsertWorkspace, { mode: "promise" });
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [activeForm, setActiveForm] = useState<"workspace" | "organization" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceOrganizationId, setWorkspaceOrganizationId] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [status, setStatus] = useState<StatusState>(defaultStatus);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [creatingOrganization, setCreatingOrganization] = useState(false);

  const organizationNameById = useMemo(
    () =>
      new Map<string, string>(
        organizations.items.map((organization) => [organization.id, organization.name]),
      ),
    [organizations.items],
  );

  const currentWorkspace = useMemo(
    () => workspaces.items.find((workspace) => workspace.id === workspaceId) ?? null,
    [workspaces.items, workspaceId],
  );

  const currentWorkspaceLabel = currentWorkspace?.name ?? "Select workspace";
  const hasOrganizations = organizations.items.length > 0;

  const currentOrganizationLabel = useMemo(
    () =>
      currentWorkspace
        ? organizationNameById.get(currentWorkspace.organizationId) ?? currentWorkspace.organizationId
        : null,
    [currentWorkspace, organizationNameById],
  );

  const organizationGroups = useMemo((): Array<OrganizationGroup> => {
    const workspacesByOrganization = new Map<string, Array<Workspace>>();

    for (const workspace of workspaces.items) {
      const existing = workspacesByOrganization.get(workspace.organizationId);
      if (existing) {
        existing.push(workspace);
      } else {
        workspacesByOrganization.set(workspace.organizationId, [workspace]);
      }
    }

    const groups = organizations.items
      .map((organization) => ({
        organizationId: organization.id,
        label: organization.name,
        workspaces: [...(workspacesByOrganization.get(organization.id) ?? [])].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      }))
      .sort((left, right) => left.label.localeCompare(right.label));

    for (const [organizationId, groupedWorkspaces] of workspacesByOrganization.entries()) {
      if (organizationNameById.has(organizationId)) {
        continue;
      }

      groups.push({
        organizationId: organizationId as Organization["id"],
        label: organizationId,
        workspaces: [...groupedWorkspaces].sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    return groups;
  }, [organizationNameById, organizations.items, workspaces.items]);

  useEffect(() => {
    if (workspaces.state !== "ready") {
      return;
    }

    if (workspaces.items.length === 0) {
      return;
    }

    const hasCurrentWorkspace = workspaces.items.some(
      (workspace) => workspace.id === workspaceId,
    );

    if (!hasCurrentWorkspace) {
      setWorkspaceId(workspaces.items[0].id);
    }
  }, [setWorkspaceId, workspaceId, workspaces.items, workspaces.state]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const selectWorkspace = (nextWorkspaceId: Workspace["id"]) => {
    setWorkspaceId(nextWorkspaceId);
    setStatus(defaultStatus());
    setActiveForm(null);
    setMenuOpen(false);
  };

  const openWorkspaceForm = (organizationId?: Organization["id"]) => {
    setStatus(defaultStatus());

    if (!menuOpen) {
      setMenuOpen(true);
    }

    if (activeForm === "workspace" && organizationId === workspaceOrganizationId) {
      setActiveForm(null);
      return;
    }

    setActiveForm("workspace");
    setWorkspaceName("");

    if (organizations.items.length === 0) {
      setWorkspaceOrganizationId("");
      setStatus({
        message: "Create an organization first.",
        variant: "error",
      });
      return;
    }

    if (organizationId) {
      setWorkspaceOrganizationId(organizationId);
      return;
    }

    if (currentWorkspace) {
      setWorkspaceOrganizationId(currentWorkspace.organizationId);
      return;
    }

    setWorkspaceOrganizationId(organizations.items[0]?.id ?? "");
  };

  const openOrganizationForm = () => {
    setStatus(defaultStatus());

    if (!menuOpen) {
      setMenuOpen(true);
    }

    if (activeForm === "organization") {
      setActiveForm(null);
      return;
    }

    setActiveForm("organization");
    setOrganizationName("");
    setOrganizationSlug("");
  };

  const handleCreateWorkspace = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const name = workspaceName.trim();
    const organizationId = workspaceOrganizationId.trim();

    if (name.length < 2) {
      setStatus({
        message: "Workspace name must be at least 2 characters.",
        variant: "error",
      });
      return;
    }

    if (organizationId.length === 0) {
      setStatus({
        message: "Select an organization first.",
        variant: "error",
      });
      return;
    }

    setCreatingWorkspace(true);

    void runUpsertWorkspace(
      toUpsertWorkspaceRequest({
        payload: toWorkspaceUpsertPayload({
          id: createWorkspaceId(),
          name,
          organizationId: organizationId as Workspace["organizationId"],
        }),
      }),
    )
      .then((workspace) => {
        setWorkspaceId(workspace.id);
        setWorkspaceName("");
        setActiveForm(null);
        setMenuOpen(false);
        setStatus({
          message: `Created workspace ${workspace.name}.`,
          variant: "info",
        });
      })
      .catch((cause) => {
        setStatus({
          message: errorMessage(cause, "Workspace creation failed."),
          variant: "error",
        });
      })
      .finally(() => {
        setCreatingWorkspace(false);
      });
  };

  const handleCreateOrganization = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const name = organizationName.trim();
    const generatedSlug = slugify(name);
    const slugInput = organizationSlug.trim();
    const slug = slugInput.length > 0 ? slugify(slugInput) : generatedSlug;

    if (name.length < 2) {
      setStatus({
        message: "Organization name must be at least 2 characters.",
        variant: "error",
      });
      return;
    }

    if (slug.length === 0) {
      setStatus({
        message: "Organization slug is required.",
        variant: "error",
      });
      return;
    }

    setCreatingOrganization(true);

    const organizationId = createOrganizationId();

    void runUpsertOrganization(
      toUpsertOrganizationRequest({
        payload: toOrganizationUpsertPayload({
          id: organizationId,
          name,
          slug,
          status: "active",
        }),
      }),
    )
      .then(async (organization) => {
        try {
          const workspace = await runUpsertWorkspace(
            toUpsertWorkspaceRequest({
              payload: toWorkspaceUpsertPayload({
                id: createWorkspaceId(),
                name,
                organizationId: organization.id as Workspace["organizationId"],
              }),
            }),
          );

          setWorkspaceId(workspace.id);
          setWorkspaceOrganizationId(organization.id);
          setOrganizationName("");
          setOrganizationSlug("");
          setActiveForm(null);
          setMenuOpen(false);
          setStatus({
            message: `Created organization ${organization.name} with workspace ${workspace.name}.`,
            variant: "info",
          });
        } catch {
          setWorkspaceOrganizationId(organization.id);
          setActiveForm("workspace");
          setStatus({
            message: `Created organization ${organization.name}, but workspace creation failed.`,
            variant: "error",
          });
        }
      })
      .catch((cause) => {
        setStatus({
          message: errorMessage(cause, "Organization creation failed."),
          variant: "error",
        });
      })
      .finally(() => {
        setCreatingOrganization(false);
      });
  };

  const workspaceCreationDisabled = creatingWorkspace || !hasOrganizations;
  const showEmptyState = workspaces.state !== "loading" && organizationGroups.length === 0;
  const selectedOrganizationLabel =
    workspaceOrganizationId.length > 0
      ? organizationNameById.get(workspaceOrganizationId) ?? workspaceOrganizationId
      : null;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="flex h-10 w-full items-center justify-between rounded-lg border border-sidebar-border bg-sidebar-active/55 px-2.5 text-left text-sidebar-foreground transition-colors hover:bg-sidebar-active/75"
        onClick={() => {
          setStatus(defaultStatus());
          setMenuOpen((open) => !open);
        }}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded bg-sidebar-active text-[10px] font-semibold text-sidebar-foreground/80">
            {(currentWorkspaceLabel[0] ?? "W").toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[10px] text-sidebar-foreground/55">
              {currentOrganizationLabel ?? "Create your first organization"}
            </span>
            <span className="block truncate text-[12px] font-medium">
              {currentWorkspaceLabel}
            </span>
          </span>
        </span>
        <ChevronsIcon className="ml-2 size-3.5 shrink-0 text-sidebar-foreground/60" />
      </button>

      {menuOpen ? (
        <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-[300px] max-w-[calc(100vw-24px)] rounded-lg border border-sidebar-border bg-sidebar p-2 shadow-lg">
          <div className="max-h-56 space-y-2 overflow-y-auto">
            {workspaces.state === "loading" ? (
              <p className="px-1 text-[11px] text-sidebar-foreground/60">Loading workspaces...</p>
            ) : null}

            {showEmptyState ? (
              <p className="px-1 text-[11px] text-sidebar-foreground/60">No workspaces yet.</p>
            ) : null}

            {organizationGroups.map((group) => (
              <div key={group.organizationId} className="space-y-1 rounded-md border border-sidebar-border/70 p-1.5">
                <div className="flex items-center justify-between gap-2 px-1">
                  <p className="truncate text-[10px] uppercase tracking-wider text-sidebar-foreground/45">
                    {group.label}
                  </p>
                  <button
                    type="button"
                    className="inline-flex h-5 items-center gap-1 rounded border border-sidebar-border px-1.5 text-[10px] text-sidebar-foreground/70 transition-colors hover:bg-sidebar-active hover:text-sidebar-foreground"
                    onClick={() => openWorkspaceForm(group.organizationId)}
                  >
                    <PlusIcon className="size-2.5" />
                    Workspace
                  </button>
                </div>

                {group.workspaces.length === 0 ? (
                  <p className="px-2 py-1 text-[11px] text-sidebar-foreground/55">No workspaces yet.</p>
                ) : null}

                {group.workspaces.map((workspace) => (
                  <button
                    key={workspace.id}
                    type="button"
                    className={cn(
                      "flex h-7 w-full items-center gap-1.5 rounded px-2 text-[12px] text-sidebar-foreground transition-colors",
                      workspace.id === workspaceId
                        ? "bg-sidebar-active"
                        : "hover:bg-sidebar-active/65",
                    )}
                    onClick={() => selectWorkspace(workspace.id)}
                  >
                    <CheckIcon
                      className={cn(
                        "size-3.5 shrink-0",
                        workspace.id === workspaceId ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="truncate">{workspace.name}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="mt-2 space-y-1 border-t border-sidebar-border pt-2">
            <Button
              type="button"
              size="sm"
              variant={activeForm === "organization" ? "secondary" : "ghost"}
              className="h-7 w-full px-2 text-[11px]"
              onClick={openOrganizationForm}
            >
              <PlusIcon className="mr-1 size-3" />
              New organization
            </Button>

            {activeForm === "workspace" ? (
              <form className="space-y-1.5 rounded-md border border-sidebar-border p-2" onSubmit={handleCreateWorkspace}>
                <p className="truncate text-[10px] uppercase tracking-wider text-sidebar-foreground/45">
                  {selectedOrganizationLabel ? `Create in ${selectedOrganizationLabel}` : "Select organization"}
                </p>
                <Input
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="Workspace name"
                  className="h-8 border-sidebar-border bg-sidebar px-2 text-[12px]"
                  maxLength={64}
                />
                <Button
                  type="submit"
                  size="sm"
                  className="h-7 w-full text-[11px]"
                  disabled={workspaceCreationDisabled}
                >
                  {creatingWorkspace ? "Creating..." : "Create workspace"}
                </Button>
              </form>
            ) : null}

            {activeForm === "organization" ? (
              <form className="space-y-1.5 rounded-md border border-sidebar-border p-2" onSubmit={handleCreateOrganization}>
                <Input
                  value={organizationName}
                  onChange={(event) => setOrganizationName(event.target.value)}
                  placeholder="Organization name"
                  className="h-8 border-sidebar-border bg-sidebar px-2 text-[12px]"
                  maxLength={64}
                />
                <Input
                  value={organizationSlug}
                  onChange={(event) => setOrganizationSlug(event.target.value)}
                  placeholder="Slug (optional)"
                  className="h-8 border-sidebar-border bg-sidebar px-2 text-[12px]"
                  maxLength={64}
                />
                <Button
                  type="submit"
                  size="sm"
                  className="h-7 w-full text-[11px]"
                  disabled={creatingOrganization}
                >
                  {creatingOrganization ? "Creating..." : "Create organization"}
                </Button>
              </form>
            ) : null}
          </div>

          {workspaces.state === "error" ? (
            <p className="mt-2 text-[11px] text-destructive">{workspaces.message}</p>
          ) : null}
          {organizations.state === "error" ? (
            <p className="mt-2 text-[11px] text-destructive">{organizations.message}</p>
          ) : null}
          {status.message ? (
            <p className={cn(
              "mt-2 text-[11px]",
              status.variant === "error"
                ? "text-destructive"
                : "text-sidebar-foreground/70",
            )}>
              {status.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

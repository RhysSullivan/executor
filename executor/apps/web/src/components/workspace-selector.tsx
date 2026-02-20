"use client";

/* eslint-disable @next/next/no-img-element */

import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "@/lib/router";
import { useMutation } from "convex/react";
import { ChevronsUpDown, Plus, Check, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";
import { cn } from "@/lib/utils";

export function WorkspaceSelector({ inHeader = false }: { inHeader?: boolean }) {
  const navigate = useNavigate();
  const createOrganizationMutation = useMutation(convexApi.organizations.create);
  const {
    context,
    mode,
    workspaces,
    switchWorkspace,
    creatingWorkspace,
    createWorkspace,
  } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [newWorkspaceIcon, setNewWorkspaceIcon] = useState<File | null>(null);
  const [createScope, setCreateScope] = useState<"current_org" | "new_org">("current_org");
  const [createTargetOrganizationId, setCreateTargetOrganizationId] = useState<(typeof workspaces)[number]["organizationId"]>(null);
  const [createTargetOrganizationName, setCreateTargetOrganizationName] = useState<string | null>(null);
  const [creatingOrganization, setCreatingOrganization] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const activeWorkspace = context
    ? workspaces.find((workspace) => workspace.id === context.workspaceId)
    : null;
  const supportsOrganizationManagement = mode !== "guest";
  const activeOrganizationLabel = activeWorkspace?.organizationName ?? "Organization";
  const activeWorkspaceLabel = activeWorkspace?.name ?? (mode === "guest" ? "Anonymous Workspace" : "Select workspace");
  const activeWorkspaceInitial = (activeWorkspaceLabel[0] ?? "W").toUpperCase();

  const workspaceGroups = useMemo(() => {
    if (!supportsOrganizationManagement) {
      return [];
    }

    const groups: Array<{
      key: string;
      organizationId: (typeof workspaces)[number]["organizationId"];
      organizationName: string;
      workspaces: Array<(typeof workspaces)[number]>;
    }> = [];
    const byKey = new Map<string, number>();

    for (const workspace of workspaces) {
      const key = workspace.organizationId ? `org:${workspace.organizationId}` : `workspace:${workspace.id}`;
      const existingIndex = byKey.get(key);
      if (existingIndex === undefined) {
        byKey.set(key, groups.length);
        groups.push({
          key,
          organizationId: workspace.organizationId,
          organizationName: workspace.organizationName,
          workspaces: [workspace],
        });
        continue;
      }

      groups[existingIndex].workspaces.push(workspace);
    }

    return groups;
  }, [supportsOrganizationManagement, workspaces]);

  const openCreateWorkspaceForOrganization = (
    organizationId: (typeof workspaces)[number]["organizationId"],
    organizationName: string,
  ) => {
    setCreateError(null);
    setNewWorkspaceName("");
    setNewWorkspaceIcon(null);
    setCreateScope("current_org");
    setCreateTargetOrganizationId(organizationId);
    setCreateTargetOrganizationName(organizationName);
    setCreateOpen(true);
  };

  const openCreateOrganization = () => {
    setCreateError(null);
    setNewWorkspaceName("");
    setNewWorkspaceIcon(null);
    setCreateScope("new_org");
    setCreateTargetOrganizationId(null);
    setCreateTargetOrganizationName(null);
    setCreateOpen(true);
  };

  const handleCreateWorkspace = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();

    const trimmed = newWorkspaceName.trim();
    if (trimmed.length < 2) {
      setCreateError("Workspace name must be at least 2 characters.");
      return;
    }

    try {
      if (createScope === "new_org") {
        setCreatingOrganization(true);
        const created = await createOrganizationMutation({ name: trimmed });
        switchWorkspace(created.workspace.id);
      } else {
        if (!createTargetOrganizationId) {
          throw new Error("Select an organization first");
        }

        await createWorkspace(trimmed, newWorkspaceIcon, createTargetOrganizationId);
      }

      setCreateError(null);
      setNewWorkspaceName("");
      setNewWorkspaceIcon(null);
      setCreateOpen(false);
    } catch (cause) {
      const fallback = createScope === "new_org" ? "Failed to create organization" : "Failed to create workspace";
      setCreateError(cause instanceof Error ? cause.message : fallback);
    } finally {
      setCreatingOrganization(false);
    }
  };

  const triggerClassName = inHeader
    ? "h-full w-full justify-between rounded-none border-0 bg-transparent px-3 text-left text-[12px] font-medium shadow-none hover:bg-accent/40"
    : "h-8 w-full justify-between text-[11px]";
  const isCreating = creatingWorkspace || creatingOrganization;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={inHeader ? "ghost" : "outline"}
            size="sm"
            className={triggerClassName}
          >
            <span className="flex items-center gap-2 min-w-0">
              {activeWorkspace?.iconUrl ? (
                <img
                  src={activeWorkspace.iconUrl}
                  alt={activeWorkspaceLabel}
                  className="h-4 w-4 rounded-sm border border-border object-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="h-4 w-4 rounded-sm border border-border bg-muted text-[9px] font-semibold flex items-center justify-center text-muted-foreground">
                  {activeWorkspaceInitial}
                </span>
              )}
              <span className={cn("min-w-0 text-left", supportsOrganizationManagement ? "leading-tight" : undefined)}>
                {supportsOrganizationManagement ? (
                  <>
                    <span className="truncate block text-[10px] text-muted-foreground">{activeOrganizationLabel}</span>
                    <span className="truncate block">{activeWorkspaceLabel}</span>
                  </>
                ) : (
                  <span className="truncate block">{activeWorkspaceLabel}</span>
                )}
              </span>
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {supportsOrganizationManagement
            ? (
              <>
                {workspaceGroups.map((group, groupIndex) => {
                  const settingsWorkspace = group.workspaces.find((workspace) => workspace.id === context?.workspaceId)
                    ?? group.workspaces[0]
                    ?? null;

                  return (
                    <div key={group.key}>
                      {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
                      <div className="px-2 py-1.5 flex items-center justify-between gap-2">
                        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground truncate">
                          {group.organizationName}
                        </span>
                        {settingsWorkspace ? (
                          <button
                            type="button"
                            className="inline-flex h-5 w-5 items-center justify-center rounded-sm border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                            onClick={() => {
                              switchWorkspace(settingsWorkspace.id);
                              navigate("/organization?tab=members");
                            }}
                            aria-label={`Open ${group.organizationName} settings`}
                            title="Organization settings"
                          >
                            <Settings className="h-3 w-3" />
                          </button>
                        ) : null}
                      </div>
                      {group.workspaces.map((workspace) => {
                        const isActive = workspace.id === context?.workspaceId;
                        return (
                          <DropdownMenuItem
                            key={workspace.id}
                            onSelect={() => switchWorkspace(workspace.id)}
                            className="text-xs"
                          >
                            <Check className={cn("mr-2 h-3.5 w-3.5", isActive ? "opacity-100" : "opacity-0")} />
                            {workspace.iconUrl ? (
                              <img
                                src={workspace.iconUrl}
                                alt={workspace.name}
                                className="mr-2 h-4 w-4 rounded-sm border border-border object-cover"
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <span className="mr-2 h-4 w-4 rounded-sm border border-border bg-muted text-[9px] font-semibold flex items-center justify-center text-muted-foreground">
                                {(workspace.name[0] ?? "W").toUpperCase()}
                              </span>
                            )}
                            <span className="min-w-0 truncate">{workspace.name}</span>
                          </DropdownMenuItem>
                        );
                      })}

                      {group.organizationId ? (
                        <DropdownMenuItem
                          onSelect={() => openCreateWorkspaceForOrganization(group.organizationId, group.organizationName)}
                          className="text-xs"
                        >
                          <Plus className="mr-2 h-3.5 w-3.5" />
                          New workspace
                        </DropdownMenuItem>
                      ) : null}
                    </div>
                  );
                })}

                {workspaces.length === 0 ? (
                  <DropdownMenuItem disabled className="text-xs">
                    No workspaces
                  </DropdownMenuItem>
                ) : null}
              </>
            )
            : (
              <DropdownMenuItem disabled className="text-xs">
                Anonymous workspace
              </DropdownMenuItem>
            )}
          {supportsOrganizationManagement ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={openCreateOrganization} className="text-xs">
                <Plus className="mr-2 h-3.5 w-3.5" />
                New organization
              </DropdownMenuItem>

            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <form className="space-y-4" onSubmit={handleCreateWorkspace}>
            <DialogHeader>
              <DialogTitle>{createScope === "new_org" ? "Create organization" : "Create workspace"}</DialogTitle>
              <DialogDescription>
                {createScope === "new_org"
                  ? "Create a new organization with a default workspace."
                  : `Create a workspace inside ${createTargetOrganizationName ?? "this organization"}.`}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Input
                value={newWorkspaceName}
                onChange={(event) => {
                  setCreateError(null);
                  setNewWorkspaceName(event.target.value);
                }}
                placeholder={createScope === "new_org" ? "Acme" : "Marketing"}
                maxLength={64}
              />
              {createScope === "current_org" ? (
                <>
                  <Input
                    type="file"
                    accept="image/*"
                    onChange={(event) => {
                      setCreateError(null);
                      setNewWorkspaceIcon(event.target.files?.[0] ?? null);
                    }}
                  />
                  {newWorkspaceIcon ? (
                    <p className="text-[11px] text-muted-foreground truncate">
                      Icon: {newWorkspaceIcon.name}
                    </p>
                  ) : null}
                </>
              ) : null}
              {createError ? (
                <p className="text-xs text-destructive">{createError}</p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={isCreating}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isCreating}>
                {isCreating
                  ? "Creating..."
                  : createScope === "new_org"
                    ? "Create organization"
                    : "Create workspace"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

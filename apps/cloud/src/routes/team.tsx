import { useReducer, useState } from "react";
import { Exit } from "effect";
import { createFileRoute } from "@tanstack/react-router";
import { useAtomValue, useAtomSet, useAtomRefresh, Result } from "@effect-atom/atom-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@executor/react/components/dialog";
import { Button } from "@executor/react/components/button";
import { Badge } from "@executor/react/components/badge";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor/react/components/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@executor/react/components/dropdown-menu";
import {
  teamMembersAtom,
  teamRolesAtom,
  inviteMember,
  removeMember,
  updateMemberRole,
} from "../web/team-atoms";

export const Route = createFileRoute("/team")({
  component: TeamPage,
});

type InviteState = {
  email: string;
  roleSlug: string;
  status: "idle" | "sending" | "error";
  error: string | null;
};

const initialInviteState: InviteState = {
  email: "",
  roleSlug: "",
  status: "idle",
  error: null,
};

type InviteAction =
  | { type: "setEmail"; email: string }
  | { type: "setRole"; roleSlug: string }
  | { type: "send" }
  | { type: "error"; message: string }
  | { type: "reset" };

function inviteReducer(state: InviteState, action: InviteAction): InviteState {
  switch (action.type) {
    case "setEmail":
      return { ...state, email: action.email };
    case "setRole":
      return { ...state, roleSlug: action.roleSlug };
    case "send":
      return { ...state, status: "sending", error: null };
    case "error":
      return { ...state, status: "error", error: action.message };
    case "reset":
      return initialInviteState;
  }
}

function formatLastActive(lastActiveAt: string | null): string {
  if (!lastActiveAt) return "\u2014";
  const date = new Date(lastActiveAt);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function TeamPage() {
  const membersResult = useAtomValue(teamMembersAtom);
  const rolesResult = useAtomValue(teamRolesAtom);
  const refreshMembers = useAtomRefresh(teamMembersAtom);
  const doRemove = useAtomSet(removeMember, { mode: "promiseExit" });
  const doUpdateRole = useAtomSet(updateMemberRole, { mode: "promiseExit" });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [search, setSearch] = useState("");

  const roles = Result.match(rolesResult, {
    onInitial: () => [] as readonly { slug: string; name: string }[],
    onFailure: () => [] as readonly { slug: string; name: string }[],
    onSuccess: ({ value }) => value.roles,
  });

  const handleRemove = async (membershipId: string, name: string) => {
    const exit = await doRemove({ path: { membershipId } });
    if (Exit.isSuccess(exit)) {
      toast.success(`Removed ${name}`);
      refreshMembers();
    } else {
      toast.error("Failed to remove member");
    }
  };

  const handleChangeRole = async (membershipId: string, roleSlug: string, roleName: string) => {
    const exit = await doUpdateRole({ path: { membershipId }, payload: { roleSlug } });
    if (Exit.isSuccess(exit)) {
      toast.success(`Role changed to ${roleName}`);
      refreshMembers();
    } else {
      toast.error("Failed to change role");
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="flex items-end justify-between mb-10">
          <h1 className="font-display text-[2rem] tracking-tight text-foreground leading-none">
            Team
          </h1>
          <Button size="sm" onClick={() => setInviteOpen(true)}>
            Invite member
          </Button>
        </div>

        {/* Search */}
        <div className="mb-4">
          <Input
            type="text"
            placeholder="Search by name or email..."
            value={search}
            onChange={(e) => setSearch((e.target as HTMLInputElement).value)}
            className="text-[0.8125rem] h-9"
          />
        </div>

        {/* Members */}
        {Result.match(membersResult, {
          onInitial: () => (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ),
          onFailure: () => (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-[0.8125rem] text-destructive">Failed to load team members</p>
            </div>
          ),
          onSuccess: ({ value }) => {
            const members = value.members;
            const filtered = search
              ? members.filter(
                  (m) =>
                    m.email.toLowerCase().includes(search.toLowerCase()) ||
                    (m.name?.toLowerCase().includes(search.toLowerCase()) ?? false),
                )
              : members;

            if (filtered.length === 0) {
              return (
                <p className="py-8 text-center text-[0.8125rem] text-muted-foreground/60">
                  {search ? "No matching members" : "No team members yet"}
                </p>
              );
            }

            return (
              <div className="space-y-px">
                {filtered.map((member) => (
                  <div
                    key={member.id}
                    className="group relative grid grid-cols-[2rem_1fr_6rem_5rem_2rem] items-center gap-3 rounded-lg border border-transparent px-4 py-3 transition-all hover:bg-muted/30"
                  >
                    {/* Avatar */}
                    {member.avatarUrl ? (
                      <img src={member.avatarUrl} alt="" className="size-8 rounded-full" />
                    ) : (
                      <div className="flex size-8 items-center justify-center rounded-full bg-muted text-[0.625rem] font-semibold text-muted-foreground">
                        {member.name
                          ? member.name
                              .split(" ")
                              .map((n) => n[0])
                              .join("")
                              .slice(0, 2)
                              .toUpperCase()
                          : member.email[0]!.toUpperCase()}
                      </div>
                    )}

                    {/* Name + email */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate text-[0.8125rem] font-medium text-foreground leading-none">
                          {member.name ?? member.email}
                        </p>
                        {member.isCurrentUser && (
                          <Badge className="bg-muted text-muted-foreground">You</Badge>
                        )}
                        {member.status === "pending" && (
                          <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                            Invited
                          </Badge>
                        )}
                      </div>
                      {member.name && (
                        <p className="mt-0.5 truncate text-[0.75rem] text-muted-foreground/70 leading-none">
                          {member.email}
                        </p>
                      )}
                    </div>

                    {/* Role */}
                    <p className="text-[0.8125rem] text-muted-foreground capitalize leading-none">
                      {member.role}
                    </p>

                    {/* Last active */}
                    <p className="text-[0.75rem] text-muted-foreground/60 leading-none">
                      {formatLastActive(member.lastActiveAt)}
                    </p>

                    {/* Actions */}
                    {!member.isCurrentUser ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <svg viewBox="0 0 16 16" className="size-3">
                              <circle cx="8" cy="3" r="1.2" fill="currentColor" />
                              <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                              <circle cx="8" cy="13" r="1.2" fill="currentColor" />
                            </svg>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          {roles.length > 0 && (
                            <>
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger className="text-[0.75rem]">
                                  Change role
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                  {roles.map((role) => (
                                    <DropdownMenuItem
                                      key={role.slug}
                                      className="text-[0.75rem]"
                                      disabled={role.slug === member.role}
                                      onClick={() =>
                                        handleChangeRole(member.id, role.slug, role.name)
                                      }
                                    >
                                      {role.name}
                                      {role.slug === member.role && (
                                        <span className="ml-auto text-muted-foreground/50">
                                          <svg viewBox="0 0 16 16" fill="none" className="size-3">
                                            <path
                                              d="M3.5 8.5L6.5 11.5L12.5 5"
                                              stroke="currentColor"
                                              strokeWidth="1.5"
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                            />
                                          </svg>
                                        </span>
                                      )}
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                              <DropdownMenuSeparator />
                            </>
                          )}
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive text-[0.75rem]"
                            onClick={() => handleRemove(member.id, member.name ?? member.email)}
                          >
                            Remove member
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <div />
                    )}
                  </div>
                ))}
              </div>
            );
          },
        })}

        <InviteDialog
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          onInvited={refreshMembers}
          roles={roles}
        />
      </div>
    </div>
  );
}

function InviteDialog(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onInvited: () => void;
  roles: readonly { slug: string; name: string }[];
}) {
  const [state, dispatch] = useReducer(inviteReducer, initialInviteState);
  const doInvite = useAtomSet(inviteMember, { mode: "promiseExit" });

  const handleInvite = async () => {
    if (!state.email.trim()) return;
    dispatch({ type: "send" });

    const exit = await doInvite({
      payload: {
        email: state.email.trim(),
        ...(state.roleSlug ? { roleSlug: state.roleSlug } : {}),
      },
    });

    if (Exit.isSuccess(exit)) {
      toast.success(`Invitation sent to ${state.email.trim()}`);
      dispatch({ type: "reset" });
      props.onOpenChange(false);
      props.onInvited();
    } else {
      dispatch({ type: "error", message: "Failed to send invitation" });
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(v) => {
        if (!v) dispatch({ type: "reset" });
        props.onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Invite member</DialogTitle>
          <DialogDescription className="text-[0.8125rem] leading-relaxed">
            Send an email invitation to join your team.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-3">
          <div className="grid gap-1.5">
            <Label
              htmlFor="invite-email"
              className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground"
            >
              Email
            </Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="colleague@company.com"
              value={state.email}
              onChange={(e) =>
                dispatch({ type: "setEmail", email: (e.target as HTMLInputElement).value })
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") handleInvite();
              }}
              className="text-[0.8125rem] h-9"
            />
          </div>

          {props.roles.length > 0 && (
            <div className="grid gap-1.5">
              <Label
                htmlFor="invite-role"
                className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground"
              >
                Role
              </Label>
              <Select
                value={state.roleSlug}
                onValueChange={(v) => dispatch({ type: "setRole", roleSlug: v })}
              >
                <SelectTrigger id="invite-role" className="h-9 text-[0.8125rem]">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {props.roles.map((role) => (
                    <SelectItem key={role.slug} value={role.slug}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {state.status === "error" && state.error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-[0.75rem] text-destructive">{state.error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            onClick={handleInvite}
            disabled={!state.email.trim() || state.status === "sending"}
          >
            {state.status === "sending" ? "Sending…" : "Send invite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

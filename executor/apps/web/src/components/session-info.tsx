"use client";

import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation } from "convex/react";
import { ChevronsUpDown, LogIn } from "lucide-react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import { workosEnabled } from "@/lib/auth-capabilities";

export function SessionInfo() {
  const {
    loading,
    isSignedInToWorkos,
    workosProfile,
    context,
    workspaces,
    resetWorkspace,
  } = useSession();
  const [searchParams] = useSearchParams();
  const deleteCurrentAccountMutation = useMutation(convexApi.accounts.deleteCurrentAccount);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const avatarUrl = workosProfile?.avatarUrl ?? null;
  const avatarLabel = workosProfile?.name || workosProfile?.email || "User";
  const avatarInitial = (avatarLabel[0] ?? "U").toUpperCase();
  const canDeleteAccount = deleteConfirmText === "DELETE";

  const activeWorkspace = context
    ? workspaces.find((workspace) => workspace.id === context.workspaceId)
    : null;
  const inferredOrganizationId = activeWorkspace?.organizationId ?? undefined;
  const hintedOrganizationId =
    searchParams.get("organization_id")
    ?? searchParams.get("organizationId")
    ?? searchParams.get("org_id")
    ?? searchParams.get("orgId")
    ?? inferredOrganizationId
    ?? undefined;
  const hintedLogin =
    searchParams.get("login_hint")
    ?? searchParams.get("loginHint")
    ?? searchParams.get("email")
    ?? undefined;
  const signInParams = new URLSearchParams();
  if (hintedOrganizationId) {
    signInParams.set("organization_id", hintedOrganizationId);
  }
  if (hintedLogin) {
    signInParams.set("login_hint", hintedLogin);
  }
  const signInHref = signInParams.size > 0 ? `/sign-in?${signInParams.toString()}` : "/sign-in";

  const handleDeleteAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canDeleteAccount || deletingAccount) {
      return;
    }

    setDeletingAccount(true);
    setDeleteError(null);
    try {
      await deleteCurrentAccountMutation({
        sessionId: context?.sessionId ?? undefined,
      });
      await resetWorkspace();
      window.location.assign(workosEnabled ? "/sign-out" : "/");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Failed to delete account";
      setDeleteError(message);
      setDeletingAccount(false);
    }
  };

  if (loading) {
    return (
      <div className="border-t border-border px-3 py-2">
        <span className="text-[11px] font-mono text-muted-foreground">Loading session...</span>
      </div>
    );
  }

  return (
    <div className="border-t border-border">
        {isSignedInToWorkos ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-14 w-full justify-between rounded-none border-0 bg-transparent px-3 py-0 text-left shadow-none hover:bg-accent/40"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {avatarUrl ? (
                      <Image
                        src={avatarUrl}
                        alt={avatarLabel}
                        width={24}
                        height={24}
                        className="h-6 w-6 rounded-full border border-border object-cover"
                        unoptimized
                      />
                    ) : (
                      <span className="h-6 w-6 rounded-full border border-border bg-muted text-[10px] font-mono text-muted-foreground flex items-center justify-center">
                        {avatarInitial}
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="text-[11px] font-medium truncate block">{avatarLabel}</span>
                      {workosProfile?.email ? (
                        <span className="text-[10px] text-muted-foreground truncate block">{workosProfile.email}</span>
                      ) : null}
                    </span>
                  </span>
                  <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="text-xs">
                  Account
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-xs"
                  onSelect={(event) => {
                    event.preventDefault();
                    setDeleteConfirmText("");
                    setDeleteError(null);
                    setAccountSettingsOpen(true);
                  }}
                >
                  Account Settings
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="text-xs">
                  <Link to="/sign-out" reloadDocument>Sign out</Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Dialog
              open={accountSettingsOpen}
              onOpenChange={(open) => {
                setAccountSettingsOpen(open);
                if (!open) {
                  setDeleteConfirmText("");
                  setDeleteError(null);
                  setDeletingAccount(false);
                }
              }}
            >
              <DialogContent className="sm:max-w-md">
                <form className="space-y-4" onSubmit={handleDeleteAccount}>
                  <DialogHeader>
                    <DialogTitle>Account Settings</DialogTitle>
                    <DialogDescription>
                      Deleting your account will remove organizations, workspaces, and data you created.
                      This cannot be undone.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-2">
                    <label htmlFor="delete-account-confirm" className="text-xs font-medium text-foreground">
                      Type DELETE to confirm
                    </label>
                    <Input
                      id="delete-account-confirm"
                      value={deleteConfirmText}
                      onChange={(event) => setDeleteConfirmText(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {deleteError ? (
                      <p className="text-xs text-destructive">{deleteError}</p>
                    ) : null}
                  </div>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setAccountSettingsOpen(false)}
                      disabled={deletingAccount}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      variant="destructive"
                      disabled={!canDeleteAccount || deletingAccount}
                    >
                      {deletingAccount ? "Deleting..." : "Delete account"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </>
        ) : (
          <div className="px-3 py-3 space-y-2">
            {workosEnabled ? (
              <Link to={signInHref} reloadDocument className="block">
                <Button
                  variant="outline"
                  className="w-full h-9 justify-center gap-2 text-xs font-medium"
                >
                  <LogIn className="h-3.5 w-3.5" />
                  Sign in
                </Button>
              </Link>
            ) : (
              <p className="text-[11px] text-muted-foreground text-center">Anonymous mode</p>
            )}
          </div>
        )}

    </div>
  );
}

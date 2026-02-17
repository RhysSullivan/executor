"use client";

import { useState } from "react";
import { Link } from "react-router";
import { Check, Copy, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSession } from "@/lib/session-context";
import { workosEnabled } from "@/lib/auth-capabilities";

const localSetupCommands = [
  "curl -fsSL https://executor.sh/install | bash",
  "executor doctor",
  "executor up",
  "executor web",
] as const;

export function NoOrganizationModal({ enabled }: { enabled: boolean }) {
  const {
    loading,
    context,
    isSignedInToWorkos,
    createAnonymousOrganization,
    creatingAnonymousOrganization,
  } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  const shouldShow = enabled
    && !loading
    && !context
    && !isSignedInToWorkos;

  const handleCreateAnonymousOrganization = async () => {
    setError(null);
    try {
      await createAnonymousOrganization();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Failed to create anonymous organization";
      setError(message);
    }
  };

  const handleCopyCommand = async (command: string) => {
    await navigator.clipboard.writeText(command);
    setCopiedCommand(command);
    setTimeout(() => {
      setCopiedCommand((current) => (current === command ? null : current));
    }, 1500);
  };

  return (
    <Dialog open={shouldShow}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Choose how to continue</DialogTitle>
          <DialogDescription>
            Sign in to access your organizations, or create an anonymous organization with a default workspace.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {workosEnabled ? (
            <Button asChild className="w-full" disabled={creatingAnonymousOrganization}>
              <Link to="/sign-in" reloadDocument className="gap-2">
                <LogIn className="h-4 w-4" />
                Sign in
              </Link>
            </Button>
          ) : null}
          <Button
            variant="outline"
            className="w-full"
            onClick={handleCreateAnonymousOrganization}
            disabled={creatingAnonymousOrganization}
          >
            {creatingAnonymousOrganization ? "Creating anonymous organization..." : "Create anonymous organization"}
          </Button>
          <div className="relative py-1">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border/60" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-background px-2 text-[11px] text-muted-foreground">Or setup locally</span>
            </div>
          </div>
          <div className="space-y-2 rounded-md border border-border/60 bg-muted/40 p-3 text-xs">
            <p className="text-sm font-medium">Setup locally</p>
            <p className="text-muted-foreground">
              Use the local runtime install flow, then start the backend and web app:
            </p>
            <div className="space-y-1">
              {localSetupCommands.map((command) => (
                <div key={command} className="flex items-center gap-2 rounded bg-background px-2 py-1.5">
                  <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] leading-relaxed">{command}</code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => void handleCopyCommand(command)}
                    aria-label={`Copy command: ${command}`}
                  >
                    {copiedCommand === command ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
              ))}
            </div>
            <p className="text-muted-foreground">
              Then open {" "}
              <a href="http://localhost:5312" className="underline underline-offset-2 hover:text-foreground">
                http://localhost:5312
              </a>
              .
            </p>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

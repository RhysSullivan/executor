"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";
import type {
  CredentialRecord,
  SourceAuthProfile,
  ToolSourceRecord,
} from "@/lib/types";
import {
  connectionDisplayName,
  parseHeaderOverrides,
} from "@/lib/credentials/source-helpers";
import { sourceForCredentialKey } from "@/lib/tools/source-helpers";
import { ConnectionAuthFields } from "./auth-fields";
import { type ConnectionMode } from "./form/dialog-state";
import { useConnectionFormDialogForm } from "./form/dialog-form";
import {
  buildSecretJson,
  connectionSubmitCopy,
  connectionSuccessCopy,
} from "./form-save";

export function ConnectionFormDialog({
  open,
  onOpenChange,
  editing,
  initialSourceKey,
  sources,
  credentials,
  sourceAuthProfiles,
  loadingSourceNames = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: CredentialRecord | null;
  initialSourceKey?: string | null;
  sources: ToolSourceRecord[];
  credentials: CredentialRecord[];
  sourceAuthProfiles: Record<string, SourceAuthProfile>;
  loadingSourceNames?: string[];
}) {
  const { context, clientConfig } = useSession();
  const upsertCredential = useAction(convexApi.credentialsNode.upsertCredential);
  const [saving, setSaving] = useState(false);
  const {
    sourceKey,
    scopeType,
    scopePreset,
    scope,
    accountId,
    connectionMode,
    existingConnectionKey,
    tokenValue,
    apiKeyValue,
    basicUsername,
    basicPassword,
    customHeadersText,
    sourceOptions,
    connectionOptions,
    compatibleConnectionOptions,
    selectedAuth,
    authBadge,
    setScopePreset,
    setAccountId,
    setConnectionMode,
    setExistingConnectionKey,
    setTokenValue,
    setApiKeyValue,
    setBasicUsername,
    setBasicPassword,
    setCustomHeadersText,
    handleSourceKeyChange,
  } = useConnectionFormDialogForm({
    open,
    editing,
    initialSourceKey,
    sources,
    credentials,
    sourceAuthProfiles,
    accountIdFallback: context?.accountId,
  });

  const storageCopy = clientConfig?.authProviderMode === "workos"
    ? "Stored encrypted"
    : "Stored locally on this machine";
  const selectedSource = sourceForCredentialKey(sources, sourceKey);
  const selectedSourceName = selectedSource?.name;
  const authDetectionPending =
    !editing
    && selectedAuth.type === "none"
    && Boolean(selectedSource)
    && Boolean(selectedSource?.type === "openapi" || selectedSource?.type === "graphql")
    && selectedSource?.config.auth === undefined
    && (selectedSourceName ? loadingSourceNames.includes(selectedSourceName) : false);
  const detectedAuthLabel = authDetectionPending ? "Detecting..." : authBadge;

  const handleSave = async () => {
    if (!context) {
      return;
    }
    if (!sourceKey.trim()) {
      toast.error("Choose an API source");
      return;
    }
    if (scope === "account" && !accountId.trim()) {
      toast.error("Account ID is required for personal credentials");
      return;
    }

    const parsedHeaders = parseHeaderOverrides(customHeadersText);
    if (!parsedHeaders.value) {
      toast.error(parsedHeaders.error ?? "Invalid header overrides");
      return;
    }

    const linkExisting = !editing && connectionMode === "existing";
    if (linkExisting && !existingConnectionKey) {
      toast.error("Select saved credentials");
      return;
    }
    if (linkExisting && !compatibleConnectionOptions.some((connection) => connection.key === existingConnectionKey)) {
      toast.error("Selected credentials do not match this scope");
      return;
    }
    const selectedExistingConnection = linkExisting
      ? compatibleConnectionOptions.find((connection) => connection.key === existingConnectionKey) ?? null
      : null;

    if (selectedAuth.type === "none") {
      if (authDetectionPending) {
        toast.error("Still detecting auth from the API spec. Try again in a few seconds.");
        return;
      }
      toast.error("This source is currently set to no auth. Configure auth before adding a connection.");
      return;
    }

    if (selectedAuth.type === "mixed" && !linkExisting && !editing) {
      toast.error("This API uses mixed auth and must reuse saved credentials");
      return;
    }

    const secretResult = buildSecretJson({
      selectedAuthType: selectedAuth.type,
      linkExisting,
      editing: Boolean(editing),
      basicUsername,
      basicPassword,
      apiKeyValue,
      tokenValue,
      parsedHeaders: parsedHeaders.value,
    });

    if (!secretResult.secretJson) {
      toast.error(secretResult.error ?? "Failed to prepare secret payload");
      return;
    }

    setSaving(true);
    try {
      const credentialScopeType = scope === "account"
        ? "account"
        : scopeType === "organization"
          ? "organization"
          : "workspace";

      await upsertCredential({
        ...(editing ? { id: editing.id } : selectedExistingConnection ? { id: selectedExistingConnection.id } : {}),
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        sourceKey: sourceKey.trim(),
        scopeType: credentialScopeType,
        ...(credentialScopeType === "account" ? { accountId: accountId.trim() as typeof context.accountId } : {}),
        secretJson: secretResult.secretJson,
      });

      toast.success(connectionSuccessCopy(Boolean(editing), linkExisting));
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save connection");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-card border-border sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">
            {editing ? "Update Connection" : "Connect API"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">API Source</Label>
            {sourceOptions.length > 0 ? (
              <Select value={sourceKey} onValueChange={handleSourceKeyChange}>
                <SelectTrigger className="h-8 text-xs bg-background">
                  <SelectValue placeholder="Select a source" />
                </SelectTrigger>
                <SelectContent>
                  {sourceOptions.map((entry) => (
                    <SelectItem key={entry.key} value={entry.key} className="text-xs">
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={sourceKey}
                onChange={(e) => handleSourceKeyChange(e.target.value)}
                placeholder="Enter source id"
                className="h-8 text-xs font-mono bg-background"
              />
            )}
          </div>

          <div className="rounded-md border border-border/70 bg-muted/30 px-2.5 py-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-muted-foreground">Detected auth</span>
              <Badge variant="outline" className="text-[9px] font-mono uppercase tracking-wider">
                {detectedAuthLabel}
              </Badge>
              {selectedAuth.inferred && !authDetectionPending && (
                <Badge variant="outline" className="text-[9px] uppercase tracking-wider">
                  inferred from spec
                </Badge>
              )}
            </div>
            {authDetectionPending && (
              <p className="text-[10px] text-muted-foreground mt-1">
                This spec is still loading. Auth settings will auto-fill once parsing completes.
              </p>
            )}
            {selectedAuth.type === "apiKey" && selectedAuth.header && (
              <p className="text-[10px] text-muted-foreground mt-1">
                API key header: <span className="font-mono">{selectedAuth.header}</span>
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Scope</Label>
              <Select value={scopePreset} onValueChange={(value) => setScopePreset(value as "only_me" | "workspace" | "organization") }>
                <SelectTrigger className="h-8 text-xs bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="only_me" className="text-xs">Only me</SelectItem>
                  <SelectItem value="workspace" className="text-xs">Workspace</SelectItem>
                  <SelectItem value="organization" className="text-xs">Organization</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Storage</Label>
              <Input value={storageCopy} readOnly className="h-8 text-xs bg-background" />
            </div>
          </div>

          {scopePreset === "only_me" && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Account ID</Label>
              <Input
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder="account_123"
                className="h-8 text-xs font-mono bg-background"
              />
            </div>
          )}

          {!editing && connectionOptions.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">How to connect</Label>
              <Select value={connectionMode} onValueChange={(value) => setConnectionMode(value as ConnectionMode)}>
                <SelectTrigger className="h-8 text-xs bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new" className="text-xs">Enter new credentials</SelectItem>
                  <SelectItem value="existing" className="text-xs">Reuse saved credentials</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {!editing && connectionMode === "existing" && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Saved Credentials</Label>
              <Select value={existingConnectionKey} onValueChange={setExistingConnectionKey}>
                <SelectTrigger className="h-8 text-xs bg-background">
                  <SelectValue placeholder="Select saved credentials" />
                </SelectTrigger>
                <SelectContent>
                  {compatibleConnectionOptions.map((connection) => (
                    <SelectItem key={connection.key} value={connection.key} className="text-xs">
                      {connectionDisplayName(sources, connection)} ({connection.sourceKeys.size} API{connection.sourceKeys.size === 1 ? "" : "s"})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {compatibleConnectionOptions.length === 0 && (
                <p className="text-[10px] text-muted-foreground">No compatible saved credentials for this scope.</p>
              )}
            </div>
          )}

          <ConnectionAuthFields
            editing={Boolean(editing)}
            connectionMode={connectionMode}
            selectedAuth={selectedAuth}
            tokenValue={tokenValue}
            apiKeyValue={apiKeyValue}
            basicUsername={basicUsername}
            basicPassword={basicPassword}
            onTokenValueChange={setTokenValue}
            onApiKeyValueChange={setApiKeyValue}
            onBasicUsernameChange={setBasicUsername}
            onBasicPasswordChange={setBasicPassword}
          />

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Extra Headers (optional)</Label>
            <Textarea
              value={customHeadersText}
              onChange={(e) => setCustomHeadersText(e.target.value)}
              rows={4}
              placeholder="x-tenant-id: acme\nx-env: staging"
              className="text-xs font-mono bg-background"
            />
          </div>

          <Button onClick={handleSave} disabled={saving || authDetectionPending} className="w-full h-9" size="sm">
            {connectionSubmitCopy(Boolean(editing), saving, connectionMode)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

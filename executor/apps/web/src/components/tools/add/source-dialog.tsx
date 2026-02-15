"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Result } from "better-result";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";
import type {
  CredentialRecord,
  OpenApiSourceQuality,
  SourceAuthProfile,
  ToolSourceRecord,
} from "@/lib/types";
import {
  compactEndpointLabel,
  formatSourceAuthBadge,
  readSourceAuth,
  sourceAuthProfileForSource,
  sourceEndpointLabel,
} from "@/lib/tools/source-helpers";
import { displaySourceName } from "@/lib/tool/source-utils";
import { SourceFavicon } from "../source-favicon";
import { workspaceQueryArgs } from "@/lib/workspace/query-args";
import type { CatalogCollectionItem } from "@/lib/catalog-collections";
import { startMcpOAuthPopup } from "@/lib/mcp/oauth-popup";
import {
  CatalogViewSection,
  CustomViewSection,
} from "./source/dialog-sections";
import { SourceAuthPanel } from "./source/auth-panel";
import {
  OpenApiQualityDetails,
  SourceQualitySummary,
} from "../source/quality-details";
import {
  useAddSourceFormState,
} from "../use/add/source/form-state";
import { saveSourceWithCredentials } from "./source-submit";

export type SourceDialogMeta = {
  quality?: OpenApiSourceQuality;
  qualityLoading?: boolean;
  warnings?: string[];
};

function resultErrorMessage(error: unknown, fallback: string): string {
  const cause = typeof error === "object" && error && "cause" in error
    ? (error as { cause?: unknown }).cause
    : error;
  if (cause instanceof Error && cause.message.trim()) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.trim()) {
    return cause;
  }
  return fallback;
}

function normalizeEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

export function AddSourceDialog({
  existingSourceNames,
  onSourceAdded,
  onSourceDeleted,
  sourceToEdit,
  sourceDialogMeta,
  sourceAuthProfiles,
  trigger,
}: {
  existingSourceNames: Set<string>;
  onSourceAdded?: (source: ToolSourceRecord, options?: { connected?: boolean }) => void;
  onSourceDeleted?: (sourceName: string) => void;
  sourceToEdit?: ToolSourceRecord;
  sourceDialogMeta?: SourceDialogMeta;
  sourceAuthProfiles?: Record<string, SourceAuthProfile>;
  trigger?: ReactNode;
}) {
  const { context } = useSession();
  const upsertToolSource = useMutation(convexApi.workspace.upsertToolSource);
  const deleteToolSource = useMutation(convexApi.workspace.deleteToolSource);
  const upsertCredential = useAction(convexApi.credentialsNode.upsertCredential);
  const credentials = useQuery(
    convexApi.workspace.listCredentials,
    workspaceQueryArgs(context),
  );
  const credentialItems = (credentials ?? []) as CredentialRecord[];
  const credentialsLoading = Boolean(context) && credentials === undefined;
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mcpOAuthBusy, setMcpOAuthBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const sourceDialogHeader = sourceToEdit ? "Edit Tool Source" : "Add Tool Source";
  const sourceDialogDescription = sourceToEdit
    ? "Update endpoint, auth, and credentials from one place."
    : "Connect a source and configure credentials in a single flow.";

  const editSourceMeta = sourceToEdit ? sourceDialogMeta : undefined;
  const editSourceWarnings = editSourceMeta?.warnings ?? [];
  const editSourceQuality = editSourceMeta?.quality;
  const editSourceQualityLoading = Boolean(editSourceMeta?.qualityLoading);
  const editAuthProfile = sourceToEdit && sourceAuthProfiles
    ? sourceAuthProfileForSource(sourceToEdit, sourceAuthProfiles)
    : undefined;
  const editAuthBadge = sourceToEdit ? formatSourceAuthBadge(sourceToEdit, editAuthProfile) : null;
  const editAuth = sourceToEdit ? readSourceAuth(sourceToEdit, editAuthProfile) : null;
  const form = useAddSourceFormState({
    open,
    sourceToEdit,
    existingSourceNames,
    credentialItems,
    actorId: context?.actorId,
  });

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
  };

  const handleCatalogAdd = (item: CatalogCollectionItem) => {
    if (!item.specUrl.trim()) {
      toast.error("Missing endpoint URL for this source");
      return;
    }
    form.handleCatalogAdd(item);
  };

  const handleCustomSubmit = async () => {
    if (!context || !form.name.trim() || !form.endpoint.trim()) {
      return;
    }

    if (form.isNameTaken(form.name)) {
      toast.error(`Source name "${form.name.trim()}" already exists`);
      return;
    }

    if (form.type === "openapi" && form.specStatus === "detecting") {
      toast.error("Spec fetch is still in progress");
      return;
    }

    setSubmitting(true);
    const saveResult = await Result.tryPromise(() =>
      saveSourceWithCredentials({
        context,
        sourceToEdit,
        credentialsLoading,
        upsertToolSource,
        upsertCredential,
        form: {
          name: form.name,
          endpoint: form.endpoint,
          type: form.type,
          baseUrl: form.baseUrl,
          mcpTransport: form.mcpTransport,
          authType: form.authType,
          authScope: form.authScope,
          apiKeyHeader: form.apiKeyHeader,
          existingScopedCredential: form.existingScopedCredential,
          buildAuthConfig: form.buildAuthConfig,
          hasCredentialInput: form.hasCredentialInput,
          buildSecretJson: form.buildSecretJson,
        },
      })
    );
    setSubmitting(false);

    if (!saveResult.isOk()) {
      toast.error(resultErrorMessage(
        saveResult.error,
        sourceToEdit ? "Failed to update source" : "Failed to add source",
      ));
      return;
    }

    const result = saveResult.value;
    onSourceAdded?.(result.source, { connected: result.connected });
    toast.success(
      sourceToEdit
        ? result.connected
          ? `Source "${form.name.trim()}" updated with credentials`
          : `Source "${form.name.trim()}" updated`
        : result.connected
          ? `Source "${form.name.trim()}" added with credentials — loading tools…`
          : `Source "${form.name.trim()}" added — loading tools…`,
    );
    if (!sourceToEdit) {
      form.reserveSourceName(form.name.trim());
    }
    form.setView("catalog");
    setOpen(false);
  };

  const handleMcpOAuthConnect = async () => {
    if (form.type !== "mcp") {
      return;
    }
    const endpoint = form.endpoint.trim();
    if (!endpoint) {
      toast.error("Enter an MCP endpoint URL first");
      return;
    }
    const initiatedEndpoint = normalizeEndpoint(endpoint);

    setMcpOAuthBusy(true);
    const oauthResult = await Result.tryPromise(() => startMcpOAuthPopup(endpoint));
    setMcpOAuthBusy(false);

    if (!oauthResult.isOk()) {
      toast.error(resultErrorMessage(oauthResult.error, "Failed to connect OAuth"));
      return;
    }

    const returnedEndpoint = normalizeEndpoint(oauthResult.value.sourceUrl);
    if (returnedEndpoint && initiatedEndpoint && returnedEndpoint !== initiatedEndpoint) {
      toast.error("OAuth finished for a different endpoint. Try again.");
      return;
    }

    const currentEndpoint = normalizeEndpoint(form.endpoint);
    if (currentEndpoint !== initiatedEndpoint) {
      toast.error("Endpoint changed while OAuth was running. Please reconnect OAuth.");
      return;
    }

    if (form.authType !== "bearer") {
      form.handleAuthTypeChange("bearer");
    }
    form.handleAuthFieldChange("tokenValue", oauthResult.value.accessToken);
    form.markMcpOAuthLinked(initiatedEndpoint);
    toast.success("OAuth linked successfully.");
  };

  const dialogTitle = sourceDialogHeader;
  const dialogDescription = sourceDialogDescription;
  const submitLabel = form.editing
    ? "Save Source"
    : form.type === "openapi" || form.type === "graphql"
      ? "Add Source + Save Credentials"
      : "Add Source";

  const handleDeleteSource = async () => {
    if (!sourceToEdit || !context) {
      return;
    }

    const confirmed = window.confirm(`Remove source "${sourceToEdit.name}" and all related tools from this workspace?`);
    if (!confirmed) {
      return;
    }

    setDeleting(true);
    try {
      await deleteToolSource({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        sourceId: sourceToEdit.id,
      });
      toast.success(`Removed "${sourceToEdit.name}"`);
      onSourceDeleted?.(sourceToEdit.name);
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove source");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" className="h-8 text-xs">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Source
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="bg-card border-border sm:max-w-lg p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="text-sm font-medium">{dialogTitle}</DialogTitle>
          <p className="text-[11px] text-muted-foreground pt-1">{dialogDescription}</p>
        </DialogHeader>

        {sourceToEdit ? (
          <div className="px-5 pt-2">
            <div className="rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
              <div className="flex items-start gap-2.5">
                <SourceFavicon
                  source={sourceToEdit}
                  iconClassName="h-5 w-5 text-muted-foreground"
                  imageClassName="w-6 h-6"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-medium truncate" title={sourceToEdit.name}>
                    {displaySourceName(sourceToEdit.name)}
                  </p>
                  <p
                    className="text-[10px] text-muted-foreground truncate mt-0.5"
                    title={sourceEndpointLabel(sourceToEdit)}
                  >
                    {compactEndpointLabel(sourceToEdit)}
                  </p>
                  <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                    <Badge variant="outline" className="h-5 px-2 text-[9px] uppercase tracking-wide">
                      {sourceToEdit.type}
                    </Badge>
                    {editAuthBadge ? (
                      <Badge
                        variant="outline"
                        className="h-5 px-2 text-[9px] uppercase tracking-wide text-primary border-primary/30"
                      >
                        {editAuthBadge}
                      </Badge>
                    ) : null}
                    {editAuth && editAuth.type !== "none" ? (
                      <Badge
                        variant="outline"
                        className="h-5 px-2 text-[9px] uppercase tracking-wide text-amber-500 border-amber-500/30"
                      >
                        auth
                      </Badge>
                    ) : null}
                    {editSourceWarnings.length > 0 ? (
                      <Badge
                        variant="outline"
                        className="h-5 px-2 text-[9px] uppercase tracking-wide text-terminal-amber border-terminal-amber/30 inline-flex items-center gap-1"
                      >
                        <AlertTriangle className="h-2.5 w-2.5" />
                        {editSourceWarnings.length} warning{editSourceWarnings.length !== 1 ? "s" : ""}
                      </Badge>
                    ) : null}
                  </div>
                </div>
              </div>
              {sourceToEdit.type === "openapi" ? (
                <div className="mt-2 flex flex-col gap-1">
                  <SourceQualitySummary
                    quality={editSourceQuality}
                    qualityLoading={editSourceQualityLoading}
                  />
                  <OpenApiQualityDetails
                    quality={editSourceQuality}
                    qualityLoading={editSourceQualityLoading}
                  />
                </div>
              ) : null}

              {editSourceWarnings.length > 0 ? (
                <div className="mt-2 rounded-sm border border-terminal-amber/30 bg-terminal-amber/5 px-2 py-1.5">
                  {editSourceWarnings.map((warning: string, index: number) => (
                    <p key={`${sourceToEdit.name}-warning-${index}`} className="text-[10px] text-terminal-amber/90">
                      {warning}
                    </p>
                  ))}
                </div>
              ) : null}

              <div className="mt-3 flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-[11px] border-terminal-red/40 text-terminal-red hover:bg-terminal-red/10"
                  onClick={handleDeleteSource}
                  disabled={deleting}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  {deleting ? "Removing..." : "Remove source"}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="p-5 space-y-4">
          {form.view === "catalog" && !sourceToEdit ? (
            <CatalogViewSection
              catalogQuery={form.catalogQuery}
              onCatalogQueryChange={form.setCatalogQuery}
              catalogSort={form.catalogSort}
              onCatalogSortChange={form.setCatalogSort}
              visibleCatalogItems={form.visibleCatalogItems}
              onSwitchToCustom={() => form.setView("custom")}
              onAddCatalog={handleCatalogAdd}
            />
          ) : (
            <CustomViewSection
              type={form.type}
              onTypeChange={form.handleTypeChange}
              typeDisabled={form.editing}
              endpoint={form.endpoint}
              onEndpointChange={form.handleEndpointChange}
              name={form.name}
              onNameChange={form.handleNameChange}
              baseUrl={form.baseUrl}
              baseUrlOptions={form.openApiBaseUrlOptions}
              onBaseUrlChange={form.setBaseUrl}
              mcpTransport={form.mcpTransport}
              onMcpTransportChange={form.setMcpTransport}
              submitting={submitting}
              submittingLabel={form.editing ? "Saving..." : "Adding..."}
              submitDisabled={submitting || !form.name.trim() || !form.endpoint.trim()}
              submitLabel={submitLabel}
              showBackToCatalog={!form.editing}
              onBackToCatalog={!form.editing ? () => form.setView("catalog") : undefined}
              onSubmit={handleCustomSubmit}
            >
              <SourceAuthPanel
                model={{
                  sourceType: form.type,
                  specStatus: form.specStatus,
                  inferredSpecAuth: form.inferredSpecAuth,
                  specError: form.specError,
                  mcpOAuthStatus: form.mcpOAuthStatus,
                  mcpOAuthDetail: form.mcpOAuthDetail,
                  mcpOAuthAuthorizationServers: form.mcpOAuthAuthorizationServers,
                  mcpOAuthConnected: form.mcpOAuthConnected,
                  authType: form.authType,
                  authScope: form.authScope,
                  apiKeyHeader: form.apiKeyHeader,
                  tokenValue: form.tokenValue,
                  apiKeyValue: form.apiKeyValue,
                  basicUsername: form.basicUsername,
                  basicPassword: form.basicPassword,
                  hasExistingCredential: Boolean(form.existingScopedCredential),
                }}
                onAuthTypeChange={form.handleAuthTypeChange}
                onAuthScopeChange={form.handleAuthScopeChange}
                onFieldChange={form.handleAuthFieldChange}
                onMcpOAuthConnect={form.type === "mcp" ? handleMcpOAuthConnect : undefined}
                mcpOAuthBusy={mcpOAuthBusy}
              />
            </CustomViewSection>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

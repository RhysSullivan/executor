"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Result } from "better-result";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  CredentialRecord,
  SourceAuthProfile,
  ToolSourceRecord,
} from "@/lib/types";
import { type OnSourceAdded, type SourceDialogMeta } from "../add/source-dialog";
import { SourceFavicon } from "../source-favicon";
import { displaySourceName } from "@/lib/tool/source-utils";
import {
  compactEndpointLabel,
  formatSourceAuthBadge,
  sourceAuthProfileForSource,
} from "@/lib/tools/source-helpers";
import { SourceQualitySummary } from "../source/quality-details";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";
import { normalizeSourceEndpoint } from "@/lib/tools/source-url";
import { createCustomSourceConfig } from "../add/source/dialog-helpers";
import {
  CatalogViewSection,
  CustomViewSection,
} from "../add/source/dialog-sections";
import { SourceAuthPanel } from "../add/source/auth-panel";
import { saveSourceWithCredentials } from "../add/source-submit";
import {
  useAddSourceFormState,
} from "../use/add/source/form-state";
import { startMcpOAuthPopup } from "@/lib/mcp/oauth-popup";
import { workspaceQueryArgs } from "@/lib/workspace/query-args";

// ── Helpers ─────────────────────────────────────────────────────────────────

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

function ownerScopeBadge(scopeType: ToolSourceRecord["scopeType"] | undefined): string {
  return scopeType === "organization" ? "org shared" : "workspace only";
}

// ── Main Panel ──────────────────────────────────────────────────────────────

export function SourceFormPanel({
  existingSourceNames,
  sourceToEdit,
  sourceDialogMeta,
  sourceAuthProfiles,
  onSourceAdded,
  onSourceDeleted,
  onClose,
}: {
  existingSourceNames: Set<string>;
  sourceToEdit?: ToolSourceRecord;
  sourceDialogMeta?: SourceDialogMeta;
  sourceAuthProfiles?: Record<string, SourceAuthProfile>;
  onSourceAdded?: OnSourceAdded;
  onSourceDeleted?: (sourceName: string) => void;
  onClose: () => void;
}) {
  const { context } = useSession();
  const upsertToolSource = useMutation(convexApi.workspace.upsertToolSource);
  const deleteToolSource = useMutation(convexApi.workspace.deleteToolSource);
  const upsertCredential = useAction(convexApi.credentialsNode.upsertCredential);
  const previewOpenApiSourceUpgrade = useAction(convexApi.executorNode.previewOpenApiSourceUpgrade);
  const credentials = useQuery(
    convexApi.workspace.listCredentials,
    workspaceQueryArgs(context),
  );
  const credentialItems = (credentials ?? []) as CredentialRecord[];
  const credentialsLoading = Boolean(context) && credentials === undefined;
  const [submitting, setSubmitting] = useState(false);
  const [mcpOAuthBusy, setMcpOAuthBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const editing = Boolean(sourceToEdit);

  // Edit-mode metadata
  const editSourceMeta = sourceToEdit ? sourceDialogMeta : undefined;
  const editSourceWarnings = editSourceMeta?.warnings ?? [];
  const editSourceQuality = editSourceMeta?.quality;
  const editSourceQualityLoading = Boolean(editSourceMeta?.qualityLoading);
  const editAuthProfile = sourceToEdit && sourceAuthProfiles
    ? sourceAuthProfileForSource(sourceToEdit, sourceAuthProfiles)
    : undefined;
  const editAuthBadge = sourceToEdit ? formatSourceAuthBadge(sourceToEdit, editAuthProfile) : null;

  // Form state — `open` is always true for the inline panel
  const form = useAddSourceFormState({
    open: true,
    sourceToEdit,
    existingSourceNames,
    credentialItems,
    accountId: context?.accountId,
  });

  const handleCatalogAdd = (item: { specUrl: string } & Parameters<typeof form.handleCatalogAdd>[0]) => {
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

    if (sourceToEdit?.type === "openapi" && form.type === "openapi") {
      const previewConfig = createCustomSourceConfig({
        type: form.type,
        endpoint: form.endpoint.trim(),
        baseUrl: form.baseUrl,
        auth: form.buildAuthConfig(),
        mcpTransport: form.mcpTransport,
        accountId: context.accountId,
      });

      const previewResult = await Result.tryPromise(() =>
        previewOpenApiSourceUpgrade({
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          sourceId: sourceToEdit.id,
          name: form.name.trim(),
          config: previewConfig,
        }),
      );

      if (!previewResult.isOk()) {
        toast.error(resultErrorMessage(previewResult.error, "Failed to preview OpenAPI changes"));
        return;
      }

      const preview = previewResult.value;
      if (preview.hasChanges) {
        const sample = (items: string[]) => items.slice(0, 8).join("\n- ");
        const added = sample(preview.addedPaths);
        const removed = sample(preview.removedPaths);
        const changed = sample(preview.changedPaths);

        const message = [
          `OpenAPI upgrade for \"${preview.currentSourceName}\"`,
          "",
          `Added: ${preview.addedCount}`,
          `Removed: ${preview.removedCount}`,
          `Changed: ${preview.changedCount}`,
          "",
          added ? `Added sample:\n- ${added}` : "",
          removed ? `Removed sample:\n- ${removed}` : "",
          changed ? `Changed sample:\n- ${changed}` : "",
          preview.truncated ? "\n(Preview truncated)" : "",
          "",
          "Apply this upgrade now?",
        ]
          .filter((line) => line.length > 0)
          .join("\n");

        const approved = window.confirm(message);
        if (!approved) {
          toast.message("Upgrade cancelled");
          return;
        }
      }
    }

    if (form.isNameTaken(form.name)) {
      toast.error(`Source name "${form.name.trim()}" already exists`);
      return;
    }

    if (form.type === "openapi" && form.specStatus !== "ready") {
      if (form.specStatus === "detecting") {
        toast.error("Spec fetch is still in progress");
        return;
      }
      toast.error(form.specError || "OpenAPI spec is invalid or could not be fetched");
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
          scopeType: form.scopeType,
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
      }),
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
    const needsCredentials = form.authType !== "none" && !result.connected;
    onSourceAdded?.(result.source, {
      connected: result.connected,
      isNew: !sourceToEdit,
    });
    if (needsCredentials) {
      toast.warning(
        sourceToEdit
          ? `Source "${form.name.trim()}" updated — credentials still needed`
          : `Source "${form.name.trim()}" added without credentials — edit to add them`,
      );
    } else {
      toast.success(
        sourceToEdit
          ? result.connected
            ? `Source "${form.name.trim()}" updated with credentials`
            : `Source "${form.name.trim()}" updated`
          : result.connected
            ? `Source "${form.name.trim()}" added with credentials — loading tools…`
            : `Source "${form.name.trim()}" added — loading tools…`,
      );
    }
    if (!sourceToEdit) {
      form.reserveSourceName(form.name.trim());
    }
    onClose();
  };

  const handleMcpOAuthConnect = async () => {
    if (form.type !== "mcp") return;
    const endpoint = form.endpoint.trim();
    if (!endpoint) {
      toast.error("Enter an MCP endpoint URL first");
      return;
    }
    const initiatedEndpoint = normalizeSourceEndpoint(endpoint);

    setMcpOAuthBusy(true);
    const oauthResult = await Result.tryPromise(() => startMcpOAuthPopup(endpoint));
    setMcpOAuthBusy(false);

    if (!oauthResult.isOk()) {
      toast.error(resultErrorMessage(oauthResult.error, "Failed to connect OAuth"));
      return;
    }

    const returnedEndpoint = normalizeSourceEndpoint(oauthResult.value.sourceUrl);
    if (returnedEndpoint && initiatedEndpoint && returnedEndpoint !== initiatedEndpoint) {
      toast.error("OAuth finished for a different endpoint. Try again.");
      return;
    }

    const currentEndpoint = normalizeSourceEndpoint(form.endpoint);
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

  const handleDeleteSource = async () => {
    if (!sourceToEdit || !context) return;
    const scopeLabel = sourceToEdit.scopeType === "organization"
      ? "your organization"
      : "this workspace";
    const confirmed = window.confirm(
      `Remove source "${sourceToEdit.name}" and all related tools from ${scopeLabel}?`,
    );
    if (!confirmed) return;

    setDeleting(true);
    try {
      await deleteToolSource({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        sourceId: sourceToEdit.id,
      });
      toast.success(`Removed "${sourceToEdit.name}"`);
      onSourceDeleted?.(sourceToEdit.name);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove source");
    } finally {
      setDeleting(false);
    }
  };

  const submitLabel = editing ? "Save Source" : "Add Source";
  const sourceInfoLoading =
    (form.type === "openapi" && form.specStatus === "detecting")
    || (form.type === "mcp" && form.mcpOAuthStatus === "checking");

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col">
      {/* ── Sticky header ────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border/40 px-5 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onClose}
            className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-mono font-semibold text-foreground">
              {editing ? "Edit source" : "Add source"}
            </h2>
            <p className="text-[10px] text-muted-foreground/60 mt-0.5">
              {editing
                ? "Update endpoint, auth, and credentials."
                : "Connect a source and configure credentials."}
            </p>
          </div>
        </div>
      </div>

      {/* ── Scrollable body ──────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        <div className="px-5 py-5 flex flex-col gap-5 flex-1 min-h-0">

          {/* Edit mode: source summary card */}
          {sourceToEdit ? (
            <div className="rounded-lg border border-border/60 bg-muted/10 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <SourceFavicon
                  source={sourceToEdit}
                  iconClassName="h-5 w-5 text-muted-foreground"
                  imageClassName="w-7 h-7"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium truncate">
                    {displaySourceName(sourceToEdit.name)}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                    {compactEndpointLabel(sourceToEdit)}
                  </p>
                  <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                    <Badge variant="outline" className="h-5 px-2 text-[9px] uppercase tracking-wide">
                      {sourceToEdit.type}
                    </Badge>
                    <Badge variant="outline" className="h-5 px-2 text-[9px] uppercase tracking-wide">
                      {ownerScopeBadge(sourceToEdit.scopeType)}
                    </Badge>
                    {editAuthBadge ? (
                      <Badge
                        variant="outline"
                        className="h-5 px-2 text-[9px] uppercase tracking-wide text-primary border-primary/30"
                      >
                        {editAuthBadge}
                      </Badge>
                    ) : null}
                    {sourceToEdit.type === "openapi" && editSourceQuality ? (
                      <SourceQualitySummary quality={editSourceQuality} qualityLoading={editSourceQualityLoading} />
                    ) : null}
                  </div>
                </div>
              </div>

              {editSourceWarnings.length > 0 ? (
                <div className="rounded-md border border-terminal-amber/20 bg-terminal-amber/5 px-3 py-2 space-y-0.5">
                  {editSourceWarnings.map((warning, i) => (
                    <p key={i} className="text-[10px] text-terminal-amber/90 flex items-start gap-1.5">
                      <AlertTriangle className="h-2.5 w-2.5 mt-0.5 shrink-0" />
                      {warning}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Form content — catalog or custom */}
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
              typeDetectionStatus={form.typeDetectionStatus}
              typeExplicitlySet={form.typeExplicitlySet}
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
              submittingLabel={editing ? "Saving..." : "Adding..."}
              submitDisabled={
                submitting
                || !form.name.trim()
                || !form.endpoint.trim()
                || (form.type === "openapi" && form.specStatus !== "ready")
              }
              submitLabel={submitLabel}
              showBackToCatalog={!form.editing}
              onBackToCatalog={!form.editing ? () => form.setView("catalog") : undefined}
              onSubmit={handleCustomSubmit}
              sourceInfoLoading={sourceInfoLoading}
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
                  scopeType: form.scopeType,
                  authScope: form.authScope,
                  apiKeyHeader: form.apiKeyHeader,
                  tokenValue: form.tokenValue,
                  apiKeyValue: form.apiKeyValue,
                  basicUsername: form.basicUsername,
                  basicPassword: form.basicPassword,
                  hasExistingCredential: Boolean(form.existingScopedCredential),
                }}
                onAuthTypeChange={form.handleAuthTypeChange}
                onScopeChange={form.handleScopePresetChange}
                onFieldChange={form.handleAuthFieldChange}
                onMcpOAuthConnect={form.type === "mcp" ? handleMcpOAuthConnect : undefined}
                onOpenApiSpecRetry={form.type === "openapi" ? form.retryOpenApiSpec : undefined}
                openApiSpecRetrying={form.type === "openapi" && form.specStatus === "detecting"}
                mcpOAuthBusy={mcpOAuthBusy}
                sourceInfoLoading={sourceInfoLoading}
              />
            </CustomViewSection>
          )}

          {/* Delete action for edit mode */}
          {sourceToEdit ? (
            <div className="pt-3 border-t border-border/30">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[11px] border-terminal-red/30 text-terminal-red hover:bg-terminal-red/10 gap-1.5"
                onClick={handleDeleteSource}
                disabled={deleting}
              >
                <Trash2 className="h-3 w-3" />
                {deleting ? "Removing..." : "Remove source"}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

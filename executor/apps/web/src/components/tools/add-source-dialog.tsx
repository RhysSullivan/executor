"use client";

import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Result } from "better-result";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";
import type { CredentialRecord, ToolSourceRecord } from "@/lib/types";
import { workspaceQueryArgs } from "@/lib/workspace-query-args";
import type { CatalogCollectionItem } from "@/lib/catalog-collections";
import { startMcpOAuthPopup } from "@/lib/mcp-oauth-popup";
import {
  CatalogViewSection,
  CustomViewSection,
} from "./add-source-dialog-sections";
import { SourceAuthPanel } from "./add-source-auth-panel";
import {
  useAddSourceFormState,
} from "./use-add-source-form-state";
import { saveSourceWithCredentials } from "./add-source-submit";

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
  sourceToEdit,
  trigger,
}: {
  existingSourceNames: Set<string>;
  onSourceAdded?: (source: ToolSourceRecord, options?: { connected?: boolean }) => void;
  sourceToEdit?: ToolSourceRecord;
  trigger?: ReactNode;
}) {
  const { context } = useSession();
  const upsertToolSource = useMutation(convexApi.workspace.upsertToolSource);
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
      toast.error("Missing OpenAPI spec URL for this API source");
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

  const dialogTitle = sourceToEdit ? "Edit Tool Source" : "Add Tool Source";
  const dialogDescription = sourceToEdit
    ? "Update endpoint, auth, and credentials from one place."
    : "Connect a source and configure credentials in a single flow.";
  const submitLabel = form.editing
    ? "Save Source"
    : form.type === "openapi" || form.type === "graphql"
      ? "Add Source + Save Credentials"
      : "Add Source";

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

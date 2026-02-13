"use client";

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { useMutation } from "convex/react";
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
import type { ToolSourceRecord } from "@/lib/types";
import {
  type CatalogCollectionItem,
} from "@/lib/catalog-collections";
import {
  catalogSourceName,
  inferNameFromUrl,
  withUniqueSourceName,
} from "@/lib/tools-source-helpers";
import {
  createCustomSourceConfig,
  getVisibleCatalogItems,
  type SourceCatalogSort,
  type SourceType,
} from "./add-source-dialog-helpers";
import {
  CatalogViewSection,
  CustomViewSection,
} from "./add-source-dialog-sections";

export function AddSourceDialog({
  existingSourceNames,
  onSourceAdded,
}: {
  existingSourceNames: Set<string>;
  onSourceAdded?: (source: ToolSourceRecord) => void;
}) {
  const { context } = useSession();
  const upsertToolSource = useMutation(convexApi.workspace.upsertToolSource);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"catalog" | "custom">("catalog");
  const [type, setType] = useState<SourceType>("mcp");
  const [name, setName] = useState("");
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [endpoint, setEndpoint] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"auto" | "streamable-http" | "sse">("auto");
  const [submitting, setSubmitting] = useState(false);
  const [locallyReservedNames, setLocallyReservedNames] = useState<string[]>([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogSort, setCatalogSort] = useState<SourceCatalogSort>("popular");
  const [addingCatalogId, setAddingCatalogId] = useState<string | null>(null);

  const visibleCatalogItems = useMemo(
    () => getVisibleCatalogItems(catalogQuery, catalogSort),
    [catalogQuery, catalogSort],
  );

  const getTakenSourceNames = () => new Set([...existingSourceNames, ...locallyReservedNames]);

  const reserveSourceName = (sourceName: string) => {
    setLocallyReservedNames((current) =>
      current.includes(sourceName)
        ? current
        : [...current, sourceName],
    );
  };

  const getUniqueAutoSourceName = (candidate: string) => {
    return withUniqueSourceName(candidate, getTakenSourceNames());
  };

  const handleEndpointChange = (value: string) => {
    setEndpoint(value);
    if (!nameManuallyEdited) {
      const inferred = inferNameFromUrl(value);
      if (inferred) {
        setName(inferred);
      }
    }
  };

  const handleNameChange = (value: string) => {
    setName(value);
    setNameManuallyEdited(true);
  };

  const resetDialogState = () => {
    setView("catalog");
    setType("mcp");
    setName("");
    setEndpoint("");
    setBaseUrl("");
    setMcpTransport("auto");
    setNameManuallyEdited(false);
    setLocallyReservedNames([]);
    setCatalogQuery("");
    setCatalogSort("popular");
    setAddingCatalogId(null);
  };

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) {
      resetDialogState();
    }
  };

  const addSource = async (
    sourceName: string,
    sourceType: "mcp" | "openapi" | "graphql",
    config: Record<string, unknown>,
  ) => {
    if (!context) {
      return;
    }
    const created = await upsertToolSource({
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      name: sourceName,
      type: sourceType,
      config,
    });
    onSourceAdded?.(created as ToolSourceRecord);
    toast.success(`Source "${sourceName}" added — loading tools…`);
  };

  const handleCatalogAdd = async (item: CatalogCollectionItem) => {
    if (!item.specUrl.trim()) {
      toast.error("Missing OpenAPI spec URL for this API source");
      return;
    }

    setAddingCatalogId(item.id);
    try {
      const sourceName = getUniqueAutoSourceName(catalogSourceName(item));
      await addSource(sourceName, "openapi", {
        spec: item.specUrl,
      });
      reserveSourceName(sourceName);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add API source");
    } finally {
      setAddingCatalogId(null);
    }
  };

  const handleCustomSubmit = async () => {
    if (!context || !name.trim() || !endpoint.trim()) {
      return;
    }

    const takenNames = [...getTakenSourceNames()].map((entry) => entry.toLowerCase());
    if (takenNames.includes(name.trim().toLowerCase())) {
      toast.error(`Source name "${name.trim()}" already exists`);
      return;
    }

    setSubmitting(true);
    try {
      const config = createCustomSourceConfig({
        type,
        endpoint,
        baseUrl,
        mcpTransport,
        actorId: context.actorId,
      });
      await addSource(name.trim(), type, config);
      reserveSourceName(name.trim());
      resetDialogState();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add source");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8 text-xs">
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add Source
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-border sm:max-w-md p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="text-sm font-medium">
            Add Tool Source
          </DialogTitle>
        </DialogHeader>

        <div className="p-5 space-y-4">
          {view === "catalog" ? (
            <CatalogViewSection
              catalogQuery={catalogQuery}
              onCatalogQueryChange={setCatalogQuery}
              catalogSort={catalogSort}
              onCatalogSortChange={setCatalogSort}
              visibleCatalogItems={visibleCatalogItems}
              addingCatalogId={addingCatalogId}
              onSwitchToCustom={() => setView("custom")}
              onAddCatalog={(item) => void handleCatalogAdd(item)}
            />
          ) : (
            <CustomViewSection
              type={type}
              onTypeChange={setType}
              endpoint={endpoint}
              onEndpointChange={handleEndpointChange}
              name={name}
              onNameChange={handleNameChange}
              baseUrl={baseUrl}
              onBaseUrlChange={setBaseUrl}
              mcpTransport={mcpTransport}
              onMcpTransportChange={setMcpTransport}
              submitting={submitting}
              submitDisabled={submitting || !name.trim() || !endpoint.trim()}
              onBackToCatalog={() => setView("catalog")}
              onSubmit={handleCustomSubmit}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

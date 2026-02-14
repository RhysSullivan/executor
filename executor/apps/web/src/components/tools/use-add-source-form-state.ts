import { useDeferredValue, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useQuery as useTanstackQuery } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";
import { fetchAndInspectOpenApiSpec, type InferredSpecAuth } from "@/lib/openapi-spec-inspector";
import type { CatalogCollectionItem } from "@/lib/catalog-collections";
import { catalogSourceName, inferNameFromUrl, sourceKeyForSource, withUniqueSourceName } from "@/lib/tools-source-helpers";
import type { CredentialRecord, CredentialScope, SourceAuthType, ToolSourceRecord } from "@/lib/types";
import { getVisibleCatalogItems, type SourceCatalogSort, type SourceType } from "./add-source-dialog-helpers";
import type { SourceAuthPanelEditableField } from "./add-source-auth-panel";
import {
  buildAuthConfig,
  buildSecretJson,
  createDefaultFormValues,
  createDefaultUiState,
  deriveBaseUrlFromEndpoint,
  deriveBaseUrlOptionsFromSpec,
  deriveServerBaseUrlOptionsFromSpec,
  endpointFromSource,
  existingCredentialMatchesAuthType,
  hasCredentialInput,
  inferAuthPatch,
  sameStringArray,
  sourceToFormValues,
  type AddSourceUiState,
  type SourceDialogView,
  type SourceFormValues,
} from "./add-source-form-utils";

export { existingCredentialMatchesAuthType } from "./add-source-form-utils";

function patchUi(
  setUi: Dispatch<SetStateAction<AddSourceUiState>>,
  patch: Partial<AddSourceUiState>,
) {
  setUi((current) => ({ ...current, ...patch }));
}

function patchUiWithAuthRevision(
  setUi: Dispatch<SetStateAction<AddSourceUiState>>,
  patch: Partial<AddSourceUiState> = {},
) {
  setUi((current) => ({
    ...current,
    ...patch,
    authRevision: current.authRevision + 1,
  }));
}

export function useAddSourceFormState({
  open,
  sourceToEdit,
  existingSourceNames,
  credentialItems,
  actorId,
}: {
  open: boolean;
  sourceToEdit?: ToolSourceRecord;
  existingSourceNames: Set<string>;
  credentialItems: CredentialRecord[];
  actorId?: string;
}) {
  const editing = Boolean(sourceToEdit);
  const editingSourceKey = sourceToEdit ? sourceKeyForSource(sourceToEdit) : null;

  const form = useForm<SourceFormValues>({ defaultValues: createDefaultFormValues() });
  const watched = useWatch({ control: form.control });
  const values: SourceFormValues = { ...createDefaultFormValues(), ...watched };
  const [ui, setUi] = useState<AddSourceUiState>(() => createDefaultUiState(sourceToEdit ? "custom" : "catalog"));

  const visibleCatalogItems = useMemo(
    () => getVisibleCatalogItems(ui.catalogQuery, ui.catalogSort),
    [ui.catalogQuery, ui.catalogSort],
  );

  const existingScopedCredential = useMemo(() => {
    if (!editingSourceKey) {
      return null;
    }

    return credentialItems
      .filter((credential) => credential.sourceKey === editingSourceKey)
      .filter((credential) => {
        if (credential.scope !== values.authScope) {
          return false;
        }
        if (values.authScope === "actor") {
          return credential.actorId === actorId;
        }
        return true;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  }, [actorId, credentialItems, editingSourceKey, values.authScope]);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (sourceToEdit) {
      const editValues = sourceToFormValues(sourceToEdit);
      form.reset(editValues);
      patchUiWithAuthRevision(setUi, {
        ...createDefaultUiState("custom"),
        openApiBaseUrlOptions: editValues.baseUrl
          ? [editValues.baseUrl]
          : (() => {
              const fallback = deriveBaseUrlFromEndpoint(editValues.endpoint);
              return fallback ? [fallback] : [];
            })(),
        authManuallyEdited: Boolean(sourceToEdit.config.auth),
      });
      return;
    }

    form.reset(createDefaultFormValues());
    patchUiWithAuthRevision(setUi, createDefaultUiState("catalog"));
  }, [form, open, sourceToEdit]);

  const getTakenSourceNames = () => {
    const taken = new Set([...existingSourceNames, ...ui.locallyReservedNames]);
    if (sourceToEdit) {
      taken.delete(sourceToEdit.name);
    }
    return taken;
  };

  const nameManuallyEdited = form.getFieldState("name").isDirty;
  const baseUrlManuallyEdited = form.getFieldState("baseUrl").isDirty;

  const handleEndpointChange = (endpoint: string) => {
    form.setValue("endpoint", endpoint, { shouldDirty: true, shouldTouch: true });

    if (values.type === "openapi") {
      const inferredBaseUrl = deriveBaseUrlFromEndpoint(endpoint);
      patchUi(setUi, {
        openApiBaseUrlOptions: inferredBaseUrl ? [inferredBaseUrl] : [],
        authManuallyEdited: false,
      });
      if (!baseUrlManuallyEdited) {
        form.setValue("baseUrl", inferredBaseUrl, { shouldDirty: false, shouldTouch: false });
      }
      return;
    }

    if (!nameManuallyEdited) {
      const inferredName = inferNameFromUrl(endpoint);
      if (inferredName) {
        form.setValue("name", inferredName, { shouldDirty: false, shouldTouch: false });
      }
    }
  };

  const handleNameChange = (name: string) => {
    form.setValue("name", name, { shouldDirty: true, shouldTouch: true });
  };

  const handleCatalogAdd = (item: CatalogCollectionItem) => {
    const name = withUniqueSourceName(catalogSourceName(item), getTakenSourceNames());
    const defaultBaseUrl = deriveBaseUrlFromEndpoint(item.specUrl);
    form.reset({
      ...createDefaultFormValues(),
      type: "openapi",
      name,
      endpoint: item.specUrl,
      baseUrl: defaultBaseUrl,
    });
    patchUiWithAuthRevision(setUi, {
      view: "custom",
      openApiBaseUrlOptions: defaultBaseUrl ? [defaultBaseUrl] : [],
      authManuallyEdited: false,
    });
  };

  const handleTypeChange = (type: SourceType) => {
    form.setValue("type", type, { shouldDirty: true, shouldTouch: true });

    if (type === "openapi") {
      const inferredBaseUrl = deriveBaseUrlFromEndpoint(values.endpoint);
      patchUi(setUi, {
        openApiBaseUrlOptions: inferredBaseUrl ? [inferredBaseUrl] : [],
        authManuallyEdited: false,
      });
      if (!baseUrlManuallyEdited) {
        form.setValue("baseUrl", inferredBaseUrl, { shouldDirty: false, shouldTouch: false });
      }
      return;
    }

    patchUiWithAuthRevision(setUi, {
      openApiBaseUrlOptions: [],
      authManuallyEdited: false,
    });
    form.setValue("authType", "none", { shouldDirty: false, shouldTouch: false });
    form.setValue("authScope", "workspace", { shouldDirty: false, shouldTouch: false });
    form.setValue("apiKeyHeader", "x-api-key", { shouldDirty: false, shouldTouch: false });
    form.setValue("tokenValue", "", { shouldDirty: false, shouldTouch: false });
    form.setValue("apiKeyValue", "", { shouldDirty: false, shouldTouch: false });
    form.setValue("basicUsername", "", { shouldDirty: false, shouldTouch: false });
    form.setValue("basicPassword", "", { shouldDirty: false, shouldTouch: false });
  };

  const bumpAuthRevision = () => patchUiWithAuthRevision(setUi);

  const handleAuthTypeChange = (authType: Exclude<SourceAuthType, "mixed">) => {
    form.setValue("authType", authType, { shouldDirty: true, shouldTouch: true });
    patchUiWithAuthRevision(setUi, { authManuallyEdited: true });
  };

  const handleAuthScopeChange = (authScope: CredentialScope) => {
    form.setValue("authScope", authScope, { shouldDirty: true, shouldTouch: true });
    patchUiWithAuthRevision(setUi, { authManuallyEdited: true });
  };

  const handleAuthFieldChange = (field: SourceAuthPanelEditableField, value: string) => {
    if (field === "apiKeyHeader") {
      form.setValue("apiKeyHeader", value, { shouldDirty: true, shouldTouch: true });
      patchUiWithAuthRevision(setUi, { authManuallyEdited: true });
      return;
    }

    if (field === "tokenValue") {
      form.setValue("tokenValue", value, { shouldDirty: true, shouldTouch: true });
      bumpAuthRevision();
      return;
    }
    if (field === "apiKeyValue") {
      form.setValue("apiKeyValue", value, { shouldDirty: true, shouldTouch: true });
      bumpAuthRevision();
      return;
    }
    if (field === "basicUsername") {
      form.setValue("basicUsername", value, { shouldDirty: true, shouldTouch: true });
      bumpAuthRevision();
      return;
    }
    form.setValue("basicPassword", value, { shouldDirty: true, shouldTouch: true });
    bumpAuthRevision();
  };

  const buildSpecFetchHeaders = (): Record<string, string> => {
    if (values.authType === "bearer") {
      const token = values.tokenValue.trim();
      if (token) {
        return { Authorization: `Bearer ${token}` };
      }
      const existingToken = typeof existingScopedCredential?.secretJson?.token === "string"
        ? existingScopedCredential.secretJson.token.trim()
        : "";
      return existingToken ? { Authorization: `Bearer ${existingToken}` } : {};
    }

    if (values.authType === "apiKey") {
      const header = values.apiKeyHeader.trim() || "x-api-key";
      const value = values.apiKeyValue.trim();
      if (value) {
        return { [header]: value };
      }
      const existingValue = typeof existingScopedCredential?.secretJson?.value === "string"
        ? existingScopedCredential.secretJson.value.trim()
        : "";
      return existingValue ? { [header]: existingValue } : {};
    }

    if (values.authType === "basic") {
      const username = values.basicUsername.trim();
      const password = values.basicPassword.trim();
      if (username && password) {
        return { Authorization: `Basic ${btoa(`${username}:${password}`)}` };
      }
      const existingUsername = typeof existingScopedCredential?.secretJson?.username === "string"
        ? existingScopedCredential.secretJson.username.trim()
        : "";
      const existingPassword = typeof existingScopedCredential?.secretJson?.password === "string"
        ? existingScopedCredential.secretJson.password.trim()
        : "";
      return existingUsername && existingPassword
        ? { Authorization: `Basic ${btoa(`${existingUsername}:${existingPassword}`)}` }
        : {};
    }

    return {};
  };

  const inspectionEndpoint = useDeferredValue(values.endpoint.trim());
  const inspectionEnabled = open
    && ui.view === "custom"
    && values.type === "openapi"
    && inspectionEndpoint.length > 0;

  const specInspectionQuery = useTanstackQuery({
    queryKey: [
      "openapi-spec-inspection",
      inspectionEndpoint,
      ui.authRevision,
      existingScopedCredential?.id,
      existingScopedCredential?.updatedAt,
    ],
    queryFn: async () => fetchAndInspectOpenApiSpec({ specUrl: inspectionEndpoint, headers: buildSpecFetchHeaders() }),
    enabled: inspectionEnabled,
    retry: false,
    staleTime: 30_000,
  });

  const inferredSpecAuth: InferredSpecAuth | null = inspectionEnabled
    ? specInspectionQuery.data?.inferredAuth ?? null
    : null;
  const specStatus: "idle" | "detecting" | "ready" | "error" = !inspectionEnabled
    ? "idle"
    : specInspectionQuery.isFetching
      ? "detecting"
      : specInspectionQuery.isError
        ? "error"
        : specInspectionQuery.data
          ? "ready"
          : "idle";
  const specError = inspectionEnabled && specInspectionQuery.isError
    ? specInspectionQuery.error instanceof Error
      ? specInspectionQuery.error.message
      : "Failed to fetch spec"
    : "";

  useEffect(() => {
    if (!inspectionEnabled || !specInspectionQuery.data) {
      return;
    }

    const result = specInspectionQuery.data;
    const nextBaseUrlOptions = deriveBaseUrlOptionsFromSpec(result.spec, inspectionEndpoint);
    if (!sameStringArray(ui.openApiBaseUrlOptions, nextBaseUrlOptions)) {
      patchUi(setUi, { openApiBaseUrlOptions: nextBaseUrlOptions });
    }

    if (!baseUrlManuallyEdited) {
      const inferredBaseUrl = nextBaseUrlOptions[0] ?? "";
      if (values.baseUrl !== inferredBaseUrl) {
        form.setValue("baseUrl", inferredBaseUrl, { shouldDirty: false, shouldTouch: false });
      }
    }

    if (!nameManuallyEdited) {
      const serverBaseUrl = deriveServerBaseUrlOptionsFromSpec(result.spec, inspectionEndpoint)[0] ?? "";
      const inferredName = serverBaseUrl ? inferNameFromUrl(serverBaseUrl) : "";
      if (inferredName && values.name !== inferredName) {
        form.setValue("name", inferredName, { shouldDirty: false, shouldTouch: false });
      }
    }

    if (!ui.authManuallyEdited) {
      const patch = inferAuthPatch(result.inferredAuth);
      form.setValue("authType", patch.authType, { shouldDirty: false, shouldTouch: false });
      form.setValue("authScope", patch.authScope, { shouldDirty: false, shouldTouch: false });
      if (result.inferredAuth.type === "apiKey") {
        form.setValue("apiKeyHeader", patch.apiKeyHeader, { shouldDirty: false, shouldTouch: false });
      }
    }
  }, [
    baseUrlManuallyEdited,
    form,
    inspectionEnabled,
    inspectionEndpoint,
    nameManuallyEdited,
    specInspectionQuery.data,
    ui.authManuallyEdited,
    ui.openApiBaseUrlOptions,
    values.baseUrl,
    values.name,
  ]);

  useEffect(() => {
    if (!inspectionEnabled || !specInspectionQuery.isError) {
      return;
    }
    const fallback = deriveBaseUrlFromEndpoint(inspectionEndpoint);
    const nextOptions = fallback ? [fallback] : [];
    if (!sameStringArray(ui.openApiBaseUrlOptions, nextOptions)) {
      patchUi(setUi, { openApiBaseUrlOptions: nextOptions });
    }
  }, [inspectionEnabled, inspectionEndpoint, specInspectionQuery.isError, ui.openApiBaseUrlOptions]);

  const isNameTaken = (candidate: string) => {
    const taken = [...getTakenSourceNames()].map((entry) => entry.toLowerCase());
    return taken.includes(candidate.trim().toLowerCase());
  };

  const reserveSourceName = (name: string) => {
    setUi((current) =>
      current.locallyReservedNames.includes(name)
        ? current
        : { ...current, locallyReservedNames: [...current.locallyReservedNames, name] },
    );
  };

  return {
    editing,
    view: ui.view,
    setView: (view: SourceDialogView) => patchUi(setUi, { view }),
    type: values.type,
    name: values.name,
    endpoint: values.endpoint,
    baseUrl: values.baseUrl,
    openApiBaseUrlOptions: ui.openApiBaseUrlOptions,
    mcpTransport: values.mcpTransport,
    catalogQuery: ui.catalogQuery,
    setCatalogQuery: (catalogQuery: string) => patchUi(setUi, { catalogQuery }),
    catalogSort: ui.catalogSort,
    setCatalogSort: (catalogSort: SourceCatalogSort) => patchUi(setUi, { catalogSort }),
    visibleCatalogItems,
    specStatus,
    specError,
    inferredSpecAuth,
    authType: values.authType,
    authScope: values.authScope,
    apiKeyHeader: values.apiKeyHeader,
    tokenValue: values.tokenValue,
    apiKeyValue: values.apiKeyValue,
    basicUsername: values.basicUsername,
    basicPassword: values.basicPassword,
    existingScopedCredential,
    handleEndpointChange,
    handleNameChange,
    handleCatalogAdd,
    handleTypeChange,
    handleAuthTypeChange,
    handleAuthScopeChange,
    handleAuthFieldChange,
    setBaseUrl: (baseUrl: string) => form.setValue("baseUrl", baseUrl, { shouldDirty: true, shouldTouch: true }),
    setMcpTransport: (mcpTransport: "auto" | "streamable-http" | "sse") =>
      form.setValue("mcpTransport", mcpTransport, { shouldDirty: true, shouldTouch: true }),
    isNameTaken,
    reserveSourceName,
    hasCredentialInput: () => hasCredentialInput(values),
    buildAuthConfig: () => buildAuthConfig(values),
    buildSecretJson: () => buildSecretJson(values),
  };
}

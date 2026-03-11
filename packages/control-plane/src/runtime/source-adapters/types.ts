import type {
  OnElicitation,
  ToolDescriptor,
  ToolSchemaBundle,
} from "@executor/codemode-core";
import type { SqlControlPlaneRows } from "#persistence";
import type {
  AccountId,
  CredentialSlot,
  Source,
  SourceBinding,
  SourceImportAuthPolicy,
  SourceTransport,
  StoredSourceRecipeDocumentRecord,
  StoredSourceRecipeOperationRecord,
  StoredSourceRecipeSchemaBundleRecord,
  StoredSourceRecipeRevisionRecord,
  StoredSourceRecord,
  StringMap,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ResolvedSourceAuthMaterial } from "../source-auth-material";
import type { ResolveSecretMaterial } from "../secret-material-providers";

export type SourceAdapterFamily = "http_api" | "mcp" | "internal";
export type SourceAdapterInputSchema = Schema.Schema<any, any, never>;
export type SourceBindingState = {
  transport: SourceTransport | null;
  queryParams: StringMap | null;
  headers: StringMap | null;
  specUrl: string | null;
  defaultHeaders: StringMap | null;
};

export type StoredSourceBindingConfig = Pick<SourceBinding, "version" | "payload">;

export type SourceAdapterSyncInput = {
  source: Source;
  resolveSecretMaterial: ResolveSecretMaterial;
  resolveAuthMaterialForSlot: (slot: CredentialSlot) => Effect.Effect<
    ResolvedSourceAuthMaterial,
    Error,
    never
  >;
};

export type SourceAdapterMaterialization = {
  manifestJson: string | null;
  manifestHash: string | null;
  sourceHash: string | null;
  documents: readonly StoredSourceRecipeDocumentRecord[];
  schemaBundles: readonly StoredSourceRecipeSchemaBundleRecord[];
  operations: readonly StoredSourceRecipeOperationRecord[];
};

export type SourceAdapterPersistedOperationMetadata = {
  method: string | null;
  pathTemplate: string | null;
  rawToolId: string | null;
  operationId: string | null;
  group: string | null;
  leaf: string | null;
  tags: readonly string[];
  searchText: string;
  interaction: "auto" | "required";
  approvalLabel: string | null;
};

export type SourceAdapterRepairRevisionInput = {
  rows: SqlControlPlaneRows;
  sourceRecord: StoredSourceRecord;
  revision: StoredSourceRecipeRevisionRecord;
  documents: readonly StoredSourceRecipeDocumentRecord[];
  operations: readonly StoredSourceRecipeOperationRecord[];
  schemaBundles: readonly ToolSchemaBundle[];
};

export type SourceAdapterInvokePersistedToolInput = {
  rows: SqlControlPlaneRows;
  workspaceId: Source["workspaceId"];
  accountId: AccountId;
  source: Source;
  path: string;
  operation: StoredSourceRecipeOperationRecord;
  schemaBundle: ToolSchemaBundle | null;
  manifestJson: string | null;
  auth: ResolvedSourceAuthMaterial;
  args: unknown;
  context?: Record<string, unknown>;
  onElicitation?: OnElicitation;
};

export type SourceAdapter = {
  key: string;
  displayName: string;
  family: SourceAdapterFamily;
  bindingConfigVersion: number;
  providerKey: string;
  defaultImportAuthPolicy: SourceImportAuthPolicy;
  primaryDocumentKind: string | null;
  primarySchemaBundleKind: string | null;
  connectPayloadSchema: SourceAdapterInputSchema | null;
  executorAddInputSchema: SourceAdapterInputSchema | null;
  executorAddHelpText: readonly string[] | null;
  executorAddInputSignatureWidth: number | null;
  serializeBindingConfig: (source: Source) => string;
  deserializeBindingConfig: (
    input: Pick<StoredSourceRecord, "id" | "bindingConfigJson">,
  ) => Effect.Effect<StoredSourceBindingConfig, Error, never>;
  bindingStateFromSource: (source: Source) => Effect.Effect<SourceBindingState, Error, never>;
  sourceConfigFromSource: (source: Source) => Record<string, unknown>;
  validateSource: (source: Source) => Effect.Effect<Source, Error, never>;
  shouldAutoProbe: (source: Source) => boolean;
  parseManifest: (input: {
    source: Pick<Source, "id" | "kind">;
    manifestJson: string | null;
  }) => Effect.Effect<unknown | null, Error, never>;
  describePersistedOperation: (input: {
    source: Source;
    path: string;
    operation: StoredSourceRecipeOperationRecord;
  }) => Effect.Effect<SourceAdapterPersistedOperationMetadata, Error, never>;
  searchNamespace?: (input: {
    source: Source;
    path: string;
    operation: StoredSourceRecipeOperationRecord;
  }) => string;
  createToolDescriptor: (input: {
    source: Source;
    operation: StoredSourceRecipeOperationRecord;
    path: string;
    schemaBundleId?: string | null;
    includeSchemas: boolean;
  }) => ToolDescriptor;
  materializeSource: (
    input: SourceAdapterSyncInput,
  ) => Effect.Effect<SourceAdapterMaterialization, Error, never>;
  invokePersistedTool: (
    input: SourceAdapterInvokePersistedToolInput,
  ) => Effect.Effect<unknown, Error, never>;
};

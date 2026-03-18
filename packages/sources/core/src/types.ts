import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OnElicitation,
  ToolDescriptor as CatalogToolDescriptor,
} from "@executor/codemode-core";
import type { Capability, CatalogV1, Executable } from "@executor/ir/model";
import * as Effect from "effect/Effect";
import type { Schema } from "effect";

import type { OAuth2ClientAuthenticationMethod } from "@executor/auth-oauth2";
import type { SourceCatalogSyncResult } from "./catalog-sync-result";
import type { SourceDiscoveryResult } from "./discovery-models";
import type {
  CredentialSlot,
  SecretRef,
  Source,
  SourceBinding,
  SourceCatalogKind,
  SourceImportAuthPolicy,
  SourceOauthClientInput,
  StringArray,
  SourceTransport,
  StoredSourceRecord,
  StringMap,
} from "./source-models";

export type RequestPlacement =
  | {
      location: "header";
      name: string;
      value: string;
    }
  | {
      location: "query";
      name: string;
      value: string;
    }
  | {
      location: "cookie";
      name: string;
      value: string;
    }
  | {
      location: "body";
      path: string;
      value: string;
    };

export type ResolvedSourceAuthMaterial = {
  placements: ReadonlyArray<RequestPlacement>;
  headers: Readonly<Record<string, string>>;
  queryParams: Readonly<Record<string, string>>;
  cookies: Readonly<Record<string, string>>;
  bodyValues: Readonly<Record<string, string>>;
  expiresAt: number | null;
  refreshAfter: number | null;
  authProvider?: OAuthClientProvider | undefined;
};

export type SecretMaterialResolveContext = {
  params?: Readonly<Record<string, string | undefined>>;
};

export type ResolveSecretMaterial = (input: {
  ref: SecretRef;
  context?: SecretMaterialResolveContext;
}) => Effect.Effect<string, Error, never>;

export type SourceAdapterConnectStrategy = "direct" | "interactive" | "none";

export type SourceAdapterCredentialStrategy =
  | "credential_managed"
  | "adapter_defined"
  | "none";

export type SourceAdapterInputSchema = Schema.Schema<any, any, never>;

export type SourceBindingState = {
  transport: SourceTransport | null;
  queryParams: StringMap | null;
  headers: StringMap | null;
  command: string | null;
  args: StringArray | null;
  env: StringMap | null;
  cwd: string | null;
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

export type SourceAdapterOauth2SetupConfig = {
  providerKey: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: readonly string[];
  headerName: string;
  prefix: string;
  clientAuthentication: OAuth2ClientAuthenticationMethod;
  authorizationParams?: Readonly<Record<string, string>>;
};

export type SourceAdapterInvokeResult = {
  data: unknown;
  error: unknown;
  headers: Record<string, string>;
  status: number | null;
};

export type SourceAdapterInvokeInput = {
  source: Source;
  capability: Capability;
  executable: Executable;
  descriptor: CatalogToolDescriptor;
  catalog: CatalogV1;
  args: unknown;
  auth: ResolvedSourceAuthMaterial;
  onElicitation?: OnElicitation;
  context?: Record<string, unknown>;
};

export type SourceAdapterDiscoveryInput = {
  normalizedUrl: string;
  headers: Readonly<Record<string, string>>;
};

export type SourceAdapter = {
  key: string;
  displayName: string;
  catalogKind: SourceCatalogKind;
  connectStrategy: SourceAdapterConnectStrategy;
  credentialStrategy: SourceAdapterCredentialStrategy;
  bindingConfigVersion: number;
  providerKey: string;
  defaultImportAuthPolicy: SourceImportAuthPolicy;
  connectPayloadSchema: SourceAdapterInputSchema | null;
  executorAddInputSchema: SourceAdapterInputSchema | null;
  executorAddHelpText: readonly string[] | null;
  executorAddInputSignatureWidth: number | null;
  localConfigBindingSchema: SourceAdapterInputSchema | null;
  localConfigBindingFromSource: (source: Source) => unknown;
  serializeBindingConfig: (source: Source) => string;
  deserializeBindingConfig: (
    input: Pick<StoredSourceRecord, "id" | "bindingConfigJson">,
  ) => Effect.Effect<StoredSourceBindingConfig, Error, never>;
  bindingStateFromSource: (source: Source) => Effect.Effect<SourceBindingState, Error, never>;
  sourceConfigFromSource: (source: Source) => Record<string, unknown>;
  validateSource: (source: Source) => Effect.Effect<Source, Error, never>;
  shouldAutoProbe: (source: Source) => boolean;
  discoveryPriority?: (input: {
    normalizedUrl: string;
  }) => number;
  detectSource?: (
    input: SourceAdapterDiscoveryInput,
  ) => Effect.Effect<SourceDiscoveryResult | null, Error, never>;
  syncCatalog: (
    input: SourceAdapterSyncInput,
  ) => Effect.Effect<SourceCatalogSyncResult, Error, never>;
  invoke: (
    input: SourceAdapterInvokeInput,
  ) => Effect.Effect<SourceAdapterInvokeResult, Error, never>;
  getOauth2SetupConfig?: (input: {
    source: Source;
    slot: CredentialSlot;
  }) => Effect.Effect<SourceAdapterOauth2SetupConfig | null, Error, never>;
  normalizeOauthClientInput?: (
    input: SourceOauthClientInput,
  ) => Effect.Effect<SourceOauthClientInput, Error, never>;
};

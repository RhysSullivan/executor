import * as Schema from "effect/Schema";

import {
  createSourceAdapterComposition,
  type SourceAdapter,
} from "@executor/source-core";
import {
  externalSourceAdapters,
} from "@executor/source-builtins";

import {
  internalSourceAdapter,
} from "./internal";

type DisabledSourcePluginPayload = {
  __sourcePluginRegistrationRequired?: true;
  [key: string]: unknown;
};

export type * from "@executor/source-core";

export const builtInSourceAdapters = [
  ...externalSourceAdapters,
  internalSourceAdapter,
] as const satisfies readonly SourceAdapter[];
const composition = createSourceAdapterComposition(builtInSourceAdapters);

export const connectableSourceAdapters = composition.connectableSourceAdapters;
export const ConnectSourcePayloadSchema =
  composition.connectPayloadSchema as unknown as Schema.Schema<
    typeof composition.connectPayloadSchema.Type | DisabledSourcePluginPayload,
    any,
    never
  >;
export type ConnectSourcePayload = typeof ConnectSourcePayloadSchema.Type;

export const executorAddableSourceAdapters = composition.executorAddableSourceAdapters;
export const ExecutorAddSourceInputSchema =
  composition.executorAddInputSchema as unknown as Schema.Schema<
    typeof composition.executorAddInputSchema.Type | DisabledSourcePluginPayload,
    any,
    never
  >;
export type ExecutorAddSourceInput = typeof ExecutorAddSourceInputSchema.Type;

export const localConfigurableSourceAdapters = composition.localConfigurableSourceAdapters;
export const hasRegisteredConnectableSourceAdapters =
  connectableSourceAdapters.length > 0;
export const hasRegisteredExecutorAddableSourceAdapters =
  executorAddableSourceAdapters.length > 0;
export const hasRegisteredExternalSourceAdapters =
  hasRegisteredConnectableSourceAdapters
  || hasRegisteredExecutorAddableSourceAdapters;

export const getSourceAdapter = composition.getSourceAdapter;
export const getSourceAdapterForSource = composition.getSourceAdapterForSource;
export const findSourceAdapterByProviderKey = composition.findSourceAdapterByProviderKey;
export const sourceBindingStateFromSource = composition.sourceBindingStateFromSource;
export const sourceAdapterCatalogKind = composition.sourceAdapterCatalogKind;
export const sourceAdapterRequiresInteractiveConnect =
  composition.sourceAdapterRequiresInteractiveConnect;
export const sourceAdapterUsesCredentialManagedAuth =
  composition.sourceAdapterUsesCredentialManagedAuth;
export const isInternalSourceAdapter = composition.isInternalSourceAdapter;

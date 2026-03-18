import type { Source, SourceCatalogKind } from "./source-models";
import type { SourceAdapter } from "./types";

export const createSourceAdapterRegistry = <const TAdapters extends readonly SourceAdapter[]>(
  adapters: TAdapters,
) => {
  const adaptersByKey = new Map<string, SourceAdapter>(
    adapters.map((adapter) => [adapter.key, adapter]),
  );

  const getSourceAdapter = (key: string): SourceAdapter => {
    const adapter = adaptersByKey.get(key);
    if (!adapter) {
      throw new Error(`Unsupported source adapter: ${key}`);
    }

    return adapter;
  };

  const getSourceAdapterForSource = (source: Pick<Source, "kind">): SourceAdapter =>
    getSourceAdapter(source.kind);

  const findSourceAdapterByProviderKey = (providerKey: string): SourceAdapter | null =>
    adapters.find((adapter) => adapter.providerKey === providerKey) ?? null;

  return {
    adapters,
    getSourceAdapter,
    getSourceAdapterForSource,
    findSourceAdapterByProviderKey,
    sourceBindingStateFromSource: (source: Source) =>
      getSourceAdapterForSource(source).bindingStateFromSource(source),
    sourceAdapterCatalogKind: (key: string): SourceCatalogKind =>
      getSourceAdapter(key).catalogKind,
    sourceAdapterRequiresInteractiveConnect: (key: string): boolean =>
      getSourceAdapter(key).connectStrategy === "interactive",
    sourceAdapterUsesCredentialManagedAuth: (key: string): boolean =>
      getSourceAdapter(key).credentialStrategy === "credential_managed",
    isInternalSourceAdapter: (key: string): boolean =>
      getSourceAdapter(key).catalogKind === "internal",
  };
};

export type SourceAdapterRegistry = ReturnType<typeof createSourceAdapterRegistry>;

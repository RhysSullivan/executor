import {
  type CatalogCollectionItem,
  HARD_CODED_CATALOG_ITEMS,
} from "@/lib/catalog-collections";

export type SourceCatalogSort = "popular" | "recent";
export type SourceType = "mcp" | "openapi" | "graphql";

const DEFAULT_MCP_ACCOUNT_QUERY_PARAM_KEY = "accountId";

import { normalizeSourceEndpoint } from "@/lib/tools/source-url";

export function getVisibleCatalogItems(
  query: string,
  sort: SourceCatalogSort,
): CatalogCollectionItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = HARD_CODED_CATALOG_ITEMS.filter((item) => {
    if (!normalizedQuery) {
      return true;
    }

    return [
      item.name,
      item.providerName,
      item.summary,
      item.categories ?? "",
    ].some((value) => value.toLowerCase().includes(normalizedQuery));
  });

  return [...filtered].sort((a, b) => {
    if (sort === "recent") {
      return new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime();
    }

    return a.rank - b.rank;
  });
}

export function createCustomSourceConfig({
  type,
  endpoint,
  baseUrl,
  auth,
  useCredentialedFetch,
  mcpTransport,
  accountId,
}: {
  type: SourceType;
  endpoint: string;
  baseUrl: string;
  auth?: Record<string, unknown>;
  useCredentialedFetch: boolean;
  mcpTransport: "auto" | "streamable-http" | "sse";
  accountId?: string;
}): Record<string, unknown> {
  const normalizedEndpoint = normalizeSourceEndpoint(endpoint);

  if (type === "mcp") {
    return {
      url: normalizedEndpoint,
      useCredentialedFetch,
      ...(auth ? { auth } : {}),
      ...(mcpTransport !== "auto" ? { transport: mcpTransport } : {}),
      ...(accountId
        ? { queryParams: { [DEFAULT_MCP_ACCOUNT_QUERY_PARAM_KEY]: accountId } }
        : {}),
    };
  }

  if (type === "graphql") {
    return {
      endpoint: normalizedEndpoint,
      useCredentialedFetch,
      ...(auth ? { auth } : {}),
    };
  }

  return {
    spec: normalizedEndpoint,
    specUrl: normalizedEndpoint,
    useCredentialedFetch,
    ...(baseUrl ? { baseUrl } : {}),
    ...(auth ? { auth } : {}),
  };
}

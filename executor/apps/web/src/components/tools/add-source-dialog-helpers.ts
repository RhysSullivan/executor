import {
  type CatalogCollectionItem,
  HARD_CODED_CATALOG_ITEMS,
} from "@/lib/catalog-collections";

export type SourceCatalogSort = "popular" | "recent";
export type SourceType = "mcp" | "openapi" | "graphql";

const DEFAULT_MCP_ACTOR_QUERY_PARAM_KEY = "userId";

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

export function endpointLabelForType(type: SourceType): string {
  if (type === "mcp") {
    return "Endpoint URL";
  }

  if (type === "graphql") {
    return "GraphQL Endpoint";
  }

  return "Spec URL";
}

export function endpointPlaceholderForType(type: SourceType): string {
  if (type === "mcp") {
    return "https://mcp-server.example.com/sse";
  }

  if (type === "graphql") {
    return "https://api.example.com/graphql";
  }

  return "https://api.example.com/openapi.json";
}

export function createCustomSourceConfig({
  type,
  endpoint,
  baseUrl,
  auth,
  mcpTransport,
  actorId,
}: {
  type: SourceType;
  endpoint: string;
  baseUrl: string;
  auth?: Record<string, unknown>;
  mcpTransport: "auto" | "streamable-http" | "sse";
  actorId?: string;
}): Record<string, unknown> {
  if (type === "mcp") {
    return {
      url: endpoint,
      ...(auth ? { auth } : {}),
      ...(mcpTransport !== "auto" ? { transport: mcpTransport } : {}),
      ...(actorId
        ? { queryParams: { [DEFAULT_MCP_ACTOR_QUERY_PARAM_KEY]: actorId } }
        : {}),
    };
  }

  if (type === "graphql") {
    return {
      endpoint,
      ...(auth ? { auth } : {}),
    };
  }

  return {
    spec: endpoint,
    specUrl: endpoint,
    ...(baseUrl ? { baseUrl } : {}),
    ...(auth ? { auth } : {}),
  };
}

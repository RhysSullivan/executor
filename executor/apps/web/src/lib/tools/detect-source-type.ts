import type { SourceType } from "@/components/tools/add/source/dialog-helpers";

export type DetectedSourceType = {
  type: SourceType;
  /** Confidence: "high" if we parsed a valid spec or got a definitive signal. */
  confidence: "high" | "medium";
};

/**
 * URL-pattern heuristic — no network request needed.
 * Returns `null` if the pattern is ambiguous.
 */
function detectFromUrlPattern(url: string): DetectedSourceType | null {
  const lower = url.toLowerCase();

  // Common OpenAPI spec URL patterns
  if (
    lower.endsWith(".json")
    || lower.endsWith(".yaml")
    || lower.endsWith(".yml")
    || lower.includes("openapi")
    || lower.includes("swagger")
    || lower.includes("/spec")
    || lower.includes("api-docs")
  ) {
    return { type: "openapi", confidence: "medium" };
  }

  // Common GraphQL patterns
  if (lower.endsWith("/graphql") || lower.endsWith("/gql") || lower.includes("graphql")) {
    return { type: "graphql", confidence: "medium" };
  }

  // Common MCP patterns
  if (lower.includes("/mcp") || lower.endsWith("/sse") || lower.includes("mcp-server")) {
    return { type: "mcp", confidence: "medium" };
  }

  return null;
}

/**
 * Try fetching the URL and inspecting the response to determine source type.
 * Uses a lightweight HEAD-then-GET approach with a short timeout.
 */
async function detectFromResponse(
  url: string,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<DetectedSourceType | null> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json, application/yaml, text/yaml, text/event-stream, */*;q=0.5",
        ...headers,
      },
      signal,
    });

    // MCP servers typically return 405 for GET (they expect POST) or
    // redirect / return text/event-stream
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

    if (contentType.includes("text/event-stream")) {
      return { type: "mcp", confidence: "high" };
    }

    // If not OK, it could be an MCP server that only accepts POST
    if (!response.ok) {
      // 405 Method Not Allowed is a strong MCP signal (expects POST)
      if (response.status === 405) {
        return { type: "mcp", confidence: "high" };
      }
      // 401/403 could be anything — can't determine type
      return null;
    }

    // Try parsing the body to detect OpenAPI or GraphQL
    const text = await response.text();
    if (!text.trim()) {
      return null;
    }

    // Try JSON parse
    try {
      const json = JSON.parse(text);
      if (typeof json === "object" && json !== null) {
        // OpenAPI indicators
        if ("openapi" in json || "swagger" in json) {
          return { type: "openapi", confidence: "high" };
        }
        // GraphQL introspection response
        if ("data" in json && typeof json.data === "object" && json.data && "__schema" in json.data) {
          return { type: "graphql", confidence: "high" };
        }
        // Postman collection
        if ("info" in json && "item" in json) {
          return { type: "openapi", confidence: "medium" };
        }
      }
    } catch {
      // Not JSON — try YAML indicators
      if (text.includes("openapi:") || text.includes("swagger:")) {
        return { type: "openapi", confidence: "high" };
      }
    }

    return null;
  } catch {
    return null;
  }
}

const DETECTION_TIMEOUT_MS = 8_000;

export type DetectSourceTypeOptions = {
  signal?: AbortSignal;
  /** Optional auth headers to include when probing the URL. */
  headers?: Record<string, string>;
};

/**
 * Detect the source type for a given URL.
 *
 * Strategy:
 * 1. Try fast URL-pattern heuristics (no network)
 * 2. Try fetching the URL and inspecting the response
 * 3. If both fail, return null (caller should fall back to MCP or show type picker)
 */
export async function detectSourceType(
  url: string,
  options?: DetectSourceTypeOptions,
): Promise<DetectedSourceType | null> {
  const { signal, headers } = options ?? {};
  // Fast path: URL pattern matching
  const patternResult = detectFromUrlPattern(url);
  if (patternResult && patternResult.confidence === "high") {
    return patternResult;
  }

  // Network probe with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DETECTION_TIMEOUT_MS);

  // Combine external signal with our timeout
  const combinedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;

  try {
    const probeResult = await detectFromResponse(url, combinedSignal, headers);
    if (probeResult) {
      return probeResult;
    }

    // If we got a medium-confidence URL pattern match but no network result,
    // still use the pattern match
    if (patternResult) {
      return patternResult;
    }

    // Default: assume MCP (most common for unknown URLs that don't match patterns)
    return { type: "mcp", confidence: "medium" };
  } finally {
    clearTimeout(timeoutId);
  }
}

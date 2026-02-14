import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function withHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  headers: Record<string, string>,
): Promise<Response> {
  const mergedHeaders = new Headers(init?.headers ?? {});
  for (const [key, value] of Object.entries(headers)) {
    mergedHeaders.set(key, value);
  }
  return fetch(input, {
    ...init,
    headers: mergedHeaders,
  });
}

export async function connectMcp(
  url: string,
  queryParams: Record<string, string> | undefined,
  preferredTransport?: "sse" | "streamable-http",
  headers?: Record<string, string>,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const endpoint = new URL(url);
  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (!key.trim()) continue;
      endpoint.searchParams.set(key, value);
    }
  }
  const client = new Client(
    { name: "executor-tool-loader", version: "0.1.0" },
    { capabilities: {} },
  );

  if (preferredTransport === "sse") {
    await client.connect(new SSEClientTransport(endpoint, {
      requestInit: headers ? { headers } : undefined,
      eventSourceInit: headers
        ? {
            fetch: (input, init) => withHeaders(input, init, headers),
          }
        : undefined,
    }));
    return { client, close: () => client.close() };
  }

  if (preferredTransport === "streamable-http") {
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: headers ? { headers } : undefined,
    }) as Parameters<Client["connect"]>[0]);
    return { client, close: () => client.close() };
  }

  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: headers ? { headers } : undefined,
    }) as Parameters<Client["connect"]>[0]);
    return { client, close: () => client.close() };
  } catch {
    await client.connect(new SSEClientTransport(endpoint, {
      requestInit: headers ? { headers } : undefined,
      eventSourceInit: headers
        ? {
            fetch: (input, init) => withHeaders(input, init, headers),
          }
        : undefined,
    }));
    return { client, close: () => client.close() };
  }
}

export function extractMcpResult(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;
  const texts = content
    .map((item) => (item && typeof item === "object" ? (item as { text?: unknown }).text : undefined))
    .filter((item): item is string => typeof item === "string");
  if (texts.length === 0) return content;
  if (texts.length === 1) return texts[0];
  return texts;
}

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { prepareOpenApiSpec } from "@executor/core/openapi-prepare";

const HEADER_FETCH_TIMEOUT_MS = 12_000;

const querySchema = z.object({
  specUrl: z.string().trim().min(1),
  sourceName: z.string().trim().min(1).optional(),
  includeDts: z.enum(["1", "true", "0", "false"]).optional(),
  headers: z.string().optional(),
});

const recordSchema = z.record(z.string(), z.unknown());

const blockedForwardedHeaderNames = new Set([
  "accept",
  "accept-encoding",
  "connection",
  "content-length",
  "content-type",
  "host",
  "origin",
  "referer",
]);

function jsonResponse(
  payload: unknown,
  status: number,
): Response {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

function sanitizeForwardHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }

  const nextHeaders: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) {
      continue;
    }
    if (blockedForwardedHeaderNames.has(key.toLowerCase())) {
      continue;
    }
    nextHeaders[key] = value;
  }

  return nextHeaders;
}

function parseHeadersQueryValue(value: string | undefined): Record<string, string> {
  if (!value) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid headers query param");
  }

  const asRecord = z.record(z.string(), z.string()).safeParse(parsed);
  if (!asRecord.success) {
    throw new Error("Invalid headers query param");
  }

  return asRecord.data;
}

function parseSpecPayload(raw: string): Record<string, unknown> {
  const jsonCandidate = (() => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();

  const yamlCandidate = jsonCandidate === null
    ? (() => {
      try {
        return parseYaml(raw);
      } catch {
        return null;
      }
    })()
    : null;

  const parsed = jsonCandidate ?? yamlCandidate;
  const parsedRecord = recordSchema.safeParse(parsed);
  if (!parsedRecord.success) {
    throw new Error("Spec payload is empty or not an object");
  }

  return parsedRecord.data;
}

async function prepareWithForwardedHeaders(
  specUrl: string,
  sourceName: string,
  includeDts: boolean,
  headers: Record<string, string>,
): Promise<Awaited<ReturnType<typeof prepareOpenApiSpec>>> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEADER_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(specUrl, {
      method: "GET",
      headers: {
        Accept: "application/json, application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.8",
        ...headers,
      },
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch spec (${response.status} ${response.statusText})`);
    }

    const raw = await response.text();
    const parsedSpec = parseSpecPayload(raw);
    return await prepareOpenApiSpec(parsedSpec, sourceName, {
      includeDts,
      profile: "inventory",
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    specUrl: url.searchParams.get("specUrl") ?? "",
    sourceName: url.searchParams.get("sourceName") ?? undefined,
    includeDts: url.searchParams.get("includeDts") ?? undefined,
    headers: url.searchParams.get("headers") ?? undefined,
  });

  if (!parsed.success) {
    return jsonResponse({ error: "Invalid generate request" }, 400);
  }

  try {
    const includeDts = parsed.data.includeDts === "1" || parsed.data.includeDts === "true";
    const sourceName = parsed.data.sourceName ?? "openapi";
    const forwardedHeaders = sanitizeForwardHeaders(parseHeadersQueryValue(parsed.data.headers));

    const prepared = Object.keys(forwardedHeaders).length === 0
      ? await prepareOpenApiSpec(parsed.data.specUrl, sourceName, {
        includeDts,
        profile: "inventory",
      })
      : await prepareWithForwardedHeaders(
        parsed.data.specUrl,
        sourceName,
        includeDts,
        forwardedHeaders,
      );

    return jsonResponse({
      status: "ready",
      prepared,
    }, 200);
  } catch (error) {
    return jsonResponse({
      status: "failed",
      error: error instanceof Error ? error.message : "Failed to generate",
    }, 502);
  }
}

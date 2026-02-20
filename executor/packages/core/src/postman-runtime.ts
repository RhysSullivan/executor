import { asStringRecord, detectJsonContentType, findUnresolvedPostmanTemplateKeys, interpolatePostmanTemplate, stringifyTemplateValue } from "./postman-utils";
import { z } from "zod";

const postmanRequestBodySchema = z.union([
  z.object({ kind: z.literal("urlencoded"), entries: z.array(z.object({ key: z.string(), value: z.string() })) }),
  z.object({ kind: z.literal("raw"), text: z.string() }),
]);

export const postmanSerializedRunSpecSchema = z.object({
  kind: z.literal("postman"),
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string()),
  queryParams: z.array(z.object({ key: z.string(), value: z.string() })),
  body: postmanRequestBodySchema.optional(),
  variables: z.record(z.string()),
  authHeaders: z.record(z.string()),
});

export type PostmanSerializedRunSpec = z.infer<typeof postmanSerializedRunSpecSchema>;

const postmanRuntimePayloadSchema = z.object({
  variables: z.record(z.unknown()).optional(),
  query: z.record(z.unknown()).optional(),
  headers: z.record(z.unknown()).optional(),
  body: z.unknown().optional(),
}).passthrough();

const recordSchema = z.record(z.unknown());

function coerceRecord(value: unknown): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export async function executePostmanRequest(
  runSpec: PostmanSerializedRunSpec,
  payload: Record<string, unknown>,
  credentialHeaders?: Record<string, string>,
): Promise<unknown> {
  const parsedPayload = postmanRuntimePayloadSchema.safeParse(payload);
  const normalizedPayload = parsedPayload.success ? parsedPayload.data : {};

  const variables = {
    ...runSpec.variables,
    ...asStringRecord(normalizedPayload.variables),
  };

  const interpolatedUrl = interpolatePostmanTemplate(runSpec.url, variables);
  const unresolvedUrlKeys = findUnresolvedPostmanTemplateKeys(interpolatedUrl);
  if (unresolvedUrlKeys.length > 0) {
    throw new Error(`Missing required URL variables: ${unresolvedUrlKeys.join(", ")}`);
  }

  let url: URL;
  try {
    url = new URL(interpolatedUrl);
  } catch {
    throw new Error(`Invalid request URL: ${interpolatedUrl}`);
  }

  for (const entry of runSpec.queryParams) {
    if (!entry.key) continue;
    const value = interpolatePostmanTemplate(entry.value, variables);
    if (value.length > 0) {
      url.searchParams.set(entry.key, value);
    }
  }

  const queryOverrides = coerceRecord(normalizedPayload.query);
  for (const [key, value] of Object.entries(queryOverrides)) {
    if (!key || value === undefined || value === null) continue;
    url.searchParams.set(key, stringifyTemplateValue(value));
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(runSpec.headers)) {
    if (!name) continue;
    headers[name] = interpolatePostmanTemplate(value, variables);
  }
  Object.assign(headers, runSpec.authHeaders);
  Object.assign(headers, credentialHeaders ?? {});

  const headerOverrides = coerceRecord(normalizedPayload.headers);
  for (const [name, value] of Object.entries(headerOverrides)) {
    if (!name || value === undefined || value === null) continue;
    headers[name] = stringifyTemplateValue(value);
  }

  const method = runSpec.method.toUpperCase();
  const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  let body: string | undefined;

  if (!readMethods.has(method)) {
    const hasExplicitBody = Object.keys(normalizedPayload).includes("body");
    if (hasExplicitBody) {
      const bodyValue = normalizedPayload.body;
      if (typeof bodyValue === "string") {
        body = bodyValue;
      } else if (bodyValue !== undefined) {
        body = JSON.stringify(bodyValue);
        if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
          headers["content-type"] = "application/json";
        }
      }
    } else if (runSpec.body?.kind === "urlencoded") {
      const params = new URLSearchParams();
      for (const entry of runSpec.body.entries) {
        if (!entry.key) continue;
        params.set(entry.key, interpolatePostmanTemplate(entry.value, variables));
      }
      body = params.toString();
      if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/x-www-form-urlencoded";
      }
    } else if (runSpec.body?.kind === "raw") {
      body = interpolatePostmanTemplate(runSpec.body.text, variables);
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }

  if (detectJsonContentType(headers) || (response.headers.get("content-type") ?? "").includes("json")) {
    return await response.json();
  }

  return await response.text();
}

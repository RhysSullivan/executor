import SwaggerParser from "@apidevtools/swagger-parser";
import openapiTS, { astToString } from "openapi-typescript";
import { Result } from "better-result";
import { z } from "zod";
import { inferOpenApiAuth } from "./openapi-auth";
import { compactOpenApiPaths } from "./openapi-compaction";
import { extractOperationIdsFromDts } from "./openapi/schema-hints";
import type { PreparedOpenApiSpec } from "./tool/source-types";
import { toPlainObject } from "./utils";

const unknownRecordSchema = z.record(z.unknown());
const OPENAPI_JSON_FETCH_TIMEOUT_MS = 45_000;

const openApiDocumentSchema = z.object({
  openapi: z.string().optional(),
  swagger: z.string().optional(),
}).catchall(z.unknown());

interface SwaggerParserAdapter {
  bundle(spec: unknown): Promise<unknown>;
  parse(spec: unknown): Promise<unknown>;
}

function createSwaggerParserAdapter(parserModule: unknown): SwaggerParserAdapter {
  if ((typeof parserModule !== "object" || parserModule === null) && typeof parserModule !== "function") {
    throw new Error("SwaggerParser module is missing parse/bundle methods");
  }

  const parse = Reflect.get(parserModule, "parse");
  const bundle = Reflect.get(parserModule, "bundle");
  if (typeof parse !== "function" || typeof bundle !== "function") {
    throw new Error("SwaggerParser module is missing parse/bundle methods");
  }

  return {
    parse: (spec) => parse(spec),
    bundle: (spec) => bundle(spec),
  };
}

function toRecordResult(value: unknown, label: string): Result<Record<string, unknown>, Error> {
  const parsed = unknownRecordSchema.safeParse(value);
  if (!parsed.success) {
    return Result.err(new Error(`${label} must be an object: ${parsed.error.message}`));
  }

  return Result.ok(parsed.data);
}

function toOpenApiTsInput(spec: Record<string, unknown>): Parameters<typeof openapiTS>[0] {
  const parsed = openApiDocumentSchema.safeParse(spec);
  if (!parsed.success) {
    throw new Error(`OpenAPI document is invalid: ${parsed.error.message}`);
  }

  return parsed.data as Parameters<typeof openapiTS>[0] & Record<string, unknown>;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function looksLikeJsonSpecUrl(value: string): boolean {
  if (!isHttpUrl(value)) {
    return false;
  }

  return /\.json($|[?#])/i.test(value);
}

async function fetchJsonOpenApiSpec(url: string, sourceName: string): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, OPENAPI_JSON_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const body = await response.text();
    if (!body.trim()) {
      throw new Error("empty response body");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid JSON payload: ${msg}`);
    }

    const asRecord = toRecordResult(parsed, `Fetched OpenAPI source '${sourceName}'`);
    if (asRecord.isErr()) {
      throw asRecord.error;
    }

    return asRecord.value;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch/parse OpenAPI source '${sourceName}': ${msg}`);
  } finally {
    clearTimeout(timeout);
  }
}

function stripBrokenDiscriminators(spec: Record<string, unknown>): Record<string, unknown> | null {
  let strippedCount = 0;

  function refExists(ref: string): boolean {
    if (!ref.startsWith("#/")) return true;
    const segments = ref.slice(2).split("/");
    let target: unknown = spec;
    for (const segment of segments) {
      if (target && typeof target === "object") {
        const targetRecord = toPlainObject(target);
        if (!targetRecord) return false;
        target = targetRecord[segment];
      } else {
        return false;
      }
    }
    return target !== undefined;
  }

  function hasBrokenDiscriminators(obj: unknown): boolean {
    if (Array.isArray(obj)) return obj.some(hasBrokenDiscriminators);
    if (obj && typeof obj === "object") {
      const record = toPlainObject(obj);
      if (!record) return false;
      if (record.discriminator && typeof record.discriminator === "object") {
        const disc = toPlainObject(record.discriminator) ?? {};
        if (disc.mapping && typeof disc.mapping === "object") {
          const mapping = toPlainObject(disc.mapping) ?? {};
          if (Object.values(mapping).some((ref) => typeof ref === "string" && !refExists(ref))) {
            return true;
          }
        }
      }
      return Object.values(record).some(hasBrokenDiscriminators);
    }
    return false;
  }

  if (!hasBrokenDiscriminators(spec)) return null;

  function walk(obj: unknown): unknown {
    if (Array.isArray(obj)) return obj.map(walk);
    if (obj && typeof obj === "object") {
      const record = toPlainObject(obj);
      if (!record) return obj;
      const clone: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (key === "discriminator" && typeof value === "object" && value !== null) {
          const disc = toPlainObject(value) ?? {};
          if (disc.mapping && typeof disc.mapping === "object") {
            const mapping = toPlainObject(disc.mapping) ?? {};
            const hasBroken = Object.values(mapping).some(
              (ref) => typeof ref === "string" && !refExists(ref),
            );
            if (hasBroken) {
              strippedCount++;
              continue;
            }
          }
        }
        clone[key] = walk(value);
      }
      return clone;
    }
    return obj;
  }

  const resultRecord = toRecordResult(walk(spec), "Patched OpenAPI spec");
  if (resultRecord.isErr()) {
    return null;
  }
  const result = resultRecord.value;
  console.warn(`[executor] stripped ${strippedCount} broken discriminator(s) from OpenAPI spec`);
  return result;
}

async function generateOpenApiDts(spec: Record<string, unknown>): Promise<string | null> {
  try {
    const ast = await openapiTS(toOpenApiTsInput(spec), { silent: true });
    return astToString(ast);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const patched = stripBrokenDiscriminators(spec);
    if (patched) {
      console.warn(`[executor] openapi-typescript failed, retrying with patched spec: ${msg}`);
      try {
        const ast = await openapiTS(toOpenApiTsInput(patched), { silent: true });
        return astToString(ast);
      } catch (retryError) {
        const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
        console.warn(`[executor] openapi-typescript retry also failed: ${retryMsg}`);
        return null;
      }
    }
    console.warn(`[executor] openapi-typescript failed, using fallback types: ${msg}`);
    return null;
  }
}

export interface PrepareOpenApiSpecOptions {
  includeDts?: boolean;
  profile?: "full" | "inventory";
  resolveSchemaRefs?: boolean;
}

export async function prepareOpenApiSpec(
  spec: string | Record<string, unknown>,
  sourceName = "openapi",
  options: PrepareOpenApiSpecOptions = {},
): Promise<PreparedOpenApiSpec> {
  const parser = createSwaggerParserAdapter(SwaggerParser);
  const includeDts = options.includeDts ?? true;
  const profile = options.profile ?? (includeDts ? "full" : "inventory");
  const shouldGenerateDts = includeDts && profile === "full";
  const shouldBundle = profile === "full" && includeDts;
  const resolveSchemaRefs = options.resolveSchemaRefs ?? (profile === "full");

  const warnings: string[] = [];

  let parsed: Record<string, unknown>;
  if (typeof spec === "string") {
    if (looksLikeJsonSpecUrl(spec)) {
      parsed = await fetchJsonOpenApiSpec(spec, sourceName);
    } else {
      let parsedValue: unknown;
      try {
        parsedValue = await parser.parse(spec);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to fetch/parse OpenAPI source '${sourceName}': ${msg}`);
      }

      const parsedRecord = toRecordResult(parsedValue, `Parsed OpenAPI source '${sourceName}'`);
      if (parsedRecord.isErr()) {
        throw new Error(`Failed to fetch/parse OpenAPI source '${sourceName}': ${parsedRecord.error.message}`);
      }

      parsed = parsedRecord.value;
    }
  } else {
    parsed = spec;
  }

  let bundled: Record<string, unknown> = parsed;
  const dtsPromise = shouldGenerateDts
    ? generateOpenApiDts(parsed)
    : Promise.resolve<string | null>(null);
  if (shouldBundle) {
    let bundledValue: unknown;
    try {
      bundledValue = await parser.bundle(parsed);
    } catch (error) {
      const bundleMessage = error instanceof Error ? error.message : String(error);
      warnings.push(`OpenAPI bundle failed for '${sourceName}', using parse-only mode: ${bundleMessage}`);
      bundled = parsed;
      bundledValue = undefined;
    }

    if (bundledValue !== undefined) {
      const bundledRecord = toRecordResult(bundledValue, `Bundled OpenAPI source '${sourceName}'`);
      if (bundledRecord.isErr()) {
        warnings.push(`OpenAPI bundle returned non-object payload for '${sourceName}', using parse-only mode`);
        bundled = parsed;
      } else {
        bundled = bundledRecord.value;
      }
    }
  }
  const dts = await dtsPromise;

  const operationTypeIds = dts ? extractOperationIdsFromDts(dts) : new Set<string>();
  const servers = Array.isArray(bundled.servers) ? bundled.servers : [];
  const inferredAuth = inferOpenApiAuth(bundled);

  const compacted = compactOpenApiPaths(
    bundled.paths,
    operationTypeIds,
    toPlainObject(toPlainObject(bundled.components)?.parameters) ?? {},
    toPlainObject(toPlainObject(bundled.components)?.schemas) ?? {},
    toPlainObject(toPlainObject(bundled.components)?.responses) ?? {},
    toPlainObject(toPlainObject(bundled.components)?.requestBodies) ?? {},
    {
      includeSchemas: profile === "full",
      includeTypeHints: true,
      includeParameterSchemas: true,
      resolveSchemaRefs,
    },
  );

  return {
    servers: servers
      .map((server) => {
        const value = toPlainObject(server)?.url;
        return typeof value === "string" ? value : "";
      })
      .filter((url) => url.length > 0),
    paths: compacted.paths,
    ...(Object.keys(compacted.refHintTable).length > 0 ? { refHintTable: compacted.refHintTable } : {}),
    dts: dts ?? undefined,
    dtsStatus: shouldGenerateDts ? (dts ? "ready" : "failed") : "skipped",
    ...(inferredAuth ? { inferredAuth } : {}),
    warnings,
  };
}

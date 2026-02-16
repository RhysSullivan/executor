import SwaggerParser from "@apidevtools/swagger-parser";
import openapiTS, { astToString } from "openapi-typescript";
import { Result } from "better-result";
import { z } from "zod";
import { inferOpenApiAuth } from "./openapi-auth";
import { compactOpenApiPaths } from "./openapi-compaction";
import { extractOperationIdsFromDts } from "./openapi/schema-hints";
import type { PreparedOpenApiSpec } from "./tool/source-types";
import { asRecord } from "./utils";

const unknownRecordSchema = z.record(z.unknown());

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

function describeResultError(error: unknown): string {
  const cause = asRecord(error).cause;
  if (cause instanceof Error) {
    return cause.message;
  }
  if (typeof cause === "string" && cause.trim().length > 0) {
    return cause;
  }

  return error instanceof Error ? error.message : String(error);
}

function stripBrokenDiscriminators(spec: Record<string, unknown>): Record<string, unknown> | null {
  let strippedCount = 0;

  function refExists(ref: string): boolean {
    if (!ref.startsWith("#/")) return true;
    const segments = ref.slice(2).split("/");
    let target: unknown = spec;
    for (const segment of segments) {
      if (target && typeof target === "object") {
        target = asRecord(target)[segment];
      } else {
        return false;
      }
    }
    return target !== undefined;
  }

  function hasBrokenDiscriminators(obj: unknown): boolean {
    if (Array.isArray(obj)) return obj.some(hasBrokenDiscriminators);
    if (obj && typeof obj === "object") {
      const record = asRecord(obj);
      if (record.discriminator && typeof record.discriminator === "object") {
        const disc = asRecord(record.discriminator);
        if (disc.mapping && typeof disc.mapping === "object") {
          const mapping = asRecord(disc.mapping);
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
      const record = asRecord(obj);
      const clone: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(record)) {
        if (key === "discriminator" && typeof value === "object" && value !== null) {
          const disc = asRecord(value);
          if (disc.mapping && typeof disc.mapping === "object") {
            const mapping = asRecord(disc.mapping);
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
    const ast = await openapiTS(spec as never, { silent: true });
    return astToString(ast);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const patched = stripBrokenDiscriminators(spec);
    if (patched) {
      console.warn(`[executor] openapi-typescript failed, retrying with patched spec: ${msg}`);
      try {
        const ast = await openapiTS(patched as never, { silent: true });
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
  const shouldBundle = profile === "full";

  const warnings: string[] = [];

  let parsed: Record<string, unknown>;
  if (typeof spec === "string") {
    const parsedResult = await Result.tryPromise(() => parser.parse(spec));
    if (parsedResult.isErr()) {
      const msg = describeResultError(parsedResult.error);
      throw new Error(`Failed to fetch/parse OpenAPI source '${sourceName}': ${msg}`);
    }

    const parsedRecord = toRecordResult(parsedResult.value, `Parsed OpenAPI source '${sourceName}'`);
    if (parsedRecord.isErr()) {
      throw new Error(`Failed to fetch/parse OpenAPI source '${sourceName}': ${parsedRecord.error.message}`);
    }

    parsed = parsedRecord.value;
  } else {
    parsed = spec;
  }

  let bundled: Record<string, unknown>;
  const dtsPromise = shouldGenerateDts
    ? generateOpenApiDts(parsed)
    : Promise.resolve<string | null>(null);
  if (shouldBundle) {
    const bundleResult = await Result.tryPromise(() => parser.bundle(parsed));
    if (bundleResult.isErr()) {
      const bundleMessage = describeResultError(bundleResult.error);
      warnings.push(`OpenAPI bundle failed for '${sourceName}', using parse-only mode: ${bundleMessage}`);
      bundled = parsed;
    } else {
      const bundledRecord = toRecordResult(bundleResult.value, `Bundled OpenAPI source '${sourceName}'`);
      if (bundledRecord.isErr()) {
        warnings.push(`OpenAPI bundle returned non-object payload for '${sourceName}', using parse-only mode`);
        bundled = parsed;
      } else {
        bundled = bundledRecord.value;
      }
    }
  } else {
    bundled = parsed;
  }
  const dts = await dtsPromise;

  const operationTypeIds = dts ? extractOperationIdsFromDts(dts) : new Set<string>();
  const servers = Array.isArray(bundled.servers) ? bundled.servers : [];
  const inferredAuth = inferOpenApiAuth(bundled);

  return {
    servers: servers
      .map((server) => {
        const value = asRecord(server).url;
        return typeof value === "string" ? value : "";
      })
      .filter((url) => url.length > 0),
    paths: compactOpenApiPaths(
      bundled.paths,
      operationTypeIds,
      asRecord(asRecord(bundled.components).parameters),
      asRecord(asRecord(bundled.components).schemas),
      asRecord(asRecord(bundled.components).responses),
      asRecord(asRecord(bundled.components).requestBodies),
      {
        includeSchemas: profile === "full",
        includeTypeHints: true,
        includeParameterSchemas: true,
      },
    ),
    dts: dts ?? undefined,
    dtsStatus: shouldGenerateDts ? (dts ? "ready" : "failed") : "skipped",
    ...(inferredAuth ? { inferredAuth } : {}),
    warnings,
  };
}

import { Effect, Option, Schema } from "effect";
import type { Layer } from "effect";
import { HttpClient } from "effect/unstable/http";

import {
  ToolFileJsonSchema,
  ToolName,
  ToolResult,
  authToolFailure,
  type PluginCtx,
  type ResolveToolsResult,
  type StorageFailure,
  type ToolDef,
  type ToolInvocationCredential,
} from "@executor-js/sdk/core";

import {
  decodeOpenApiIntegrationConfig,
  renderAuthTemplate,
  requiredTemplateVariables,
  type OpenApiIntegrationConfig,
} from "./config";
import { OpenApiExtractionError, OpenApiParseError } from "./errors";
import { extract } from "./extract";
import { compileToolDefinitions, type ToolDefinition } from "./definitions";
import { annotationsForOperation, invokeWithLayer } from "./invoke";
import { parse, type ParsedDocument } from "./parse";
import { type OpenapiStore, type StoredOperation } from "./store";
import { OperationBinding } from "./types";

const STRINGIFIED_BODY_CAP = 1024;
const UpstreamMessageBody = Schema.Struct({ message: Schema.String });
const UpstreamErrorMessageBody = Schema.Struct({ errorMessage: Schema.String });
const UpstreamNestedErrorBody = Schema.Struct({ error: UpstreamMessageBody });
const UpstreamErrorsArrayBody = Schema.Struct({
  errors: Schema.Array(
    Schema.Struct({
      detail: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      title: Schema.optional(Schema.String),
    }),
  ),
});
const UpstreamDescriptionBody = Schema.Struct({
  detail: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});

const decodeUpstreamMessageBody = Schema.decodeUnknownOption(UpstreamMessageBody);
const decodeUpstreamErrorMessageBody = Schema.decodeUnknownOption(UpstreamErrorMessageBody);
const decodeUpstreamNestedErrorBody = Schema.decodeUnknownOption(UpstreamNestedErrorBody);
const decodeUpstreamErrorsArrayBody = Schema.decodeUnknownOption(UpstreamErrorsArrayBody);
const decodeUpstreamDescriptionBody = Schema.decodeUnknownOption(UpstreamDescriptionBody);

const clampedStringify = (value: unknown): string => {
  let s: string;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: JSON.stringify may throw on cycles; fall back to String() so the upstream body can still be surfaced as ToolError.details fallback text
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length > STRINGIFIED_BODY_CAP ? `${s.slice(0, STRINGIFIED_BODY_CAP)}…` : s;
};

const firstNonEmpty = (...values: readonly (string | undefined)[]): string | undefined =>
  values.find((value) => value !== undefined && value.length > 0);

export const extractOpenApiUpstreamMessage = (body: unknown, status: number): string => {
  if (typeof body === "string") {
    return body.length > 0 ? body : `Upstream returned HTTP ${status}`;
  }
  const nested = Option.getOrUndefined(decodeUpstreamNestedErrorBody(body));
  const messageBody = Option.getOrUndefined(decodeUpstreamMessageBody(body));
  const errorMessageBody = Option.getOrUndefined(decodeUpstreamErrorMessageBody(body));
  const errorsBody = Option.getOrUndefined(decodeUpstreamErrorsArrayBody(body));
  const descriptionBody = Option.getOrUndefined(decodeUpstreamDescriptionBody(body));
  const arrayMessage = errorsBody?.errors
    .map(
      ({
        detail,
        message: upstreamMessage,
        title,
      }: {
        detail?: string;
        message?: string;
        title?: string;
      }) => firstNonEmpty(detail, upstreamMessage, title),
    )
    .find((message: string | undefined) => message !== undefined);
  const message = firstNonEmpty(
    nested?.error.message,
    messageBody?.message,
    errorMessageBody?.errorMessage,
    arrayMessage,
    descriptionBody?.detail,
    descriptionBody?.title,
    descriptionBody?.description,
  );
  if (message !== undefined) return message;
  if (body !== null && typeof body === "object") {
    return clampedStringify(body);
  }
  return `Upstream returned HTTP ${status}`;
};

const openApiAuthToolFailure = (failure: {
  readonly code: string;
  readonly message: string;
  readonly owner: "org" | "user";
  readonly integration: string;
  readonly connection: string;
  readonly credentialKind: "secret" | "oauth" | "upstream";
  readonly credentialLabel?: string;
  readonly status?: number;
  readonly details?: unknown;
}) =>
  authToolFailure({
    code: failure.code as Parameters<typeof authToolFailure>[0]["code"],
    message: failure.message,
    source: { id: failure.integration, scope: failure.owner },
    credential: {
      kind: failure.credentialKind,
      ...(failure.credentialLabel ? { label: failure.credentialLabel } : {}),
    },
    ...(failure.status !== undefined ? { status: failure.status } : {}),
    ...(failure.details !== undefined
      ? {
          upstream: {
            ...(failure.status !== undefined ? { status: failure.status } : {}),
            details: failure.details,
          },
        }
      : {}),
  });

/** Rewrite OpenAPI `#/components/schemas/X` refs to standard `#/$defs/X`. */
export const normalizeOpenApiRefs = (node: unknown): unknown => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((item) => {
      const n = normalizeOpenApiRefs(item);
      if (n !== item) changed = true;
      return n;
    });
    return changed ? out : node;
  }

  const obj = node as Record<string, unknown>;

  if (typeof obj.$ref === "string") {
    const match = obj.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (match) return { ...obj, $ref: `#/$defs/${match[1]}` };
    return obj;
  }

  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = normalizeOpenApiRefs(v);
    if (n !== v) changed = true;
    result[k] = n;
  }
  return changed ? result : obj;
};

const toBinding = (def: ToolDefinition): OperationBinding =>
  OperationBinding.make({
    method: def.operation.method,
    servers: def.operation.servers,
    pathTemplate: def.operation.pathTemplate,
    parameters: [...def.operation.parameters],
    requestBody: def.operation.requestBody,
    responseBody: def.operation.responseBody,
  });

const descriptionFor = (def: ToolDefinition): string => {
  const op = def.operation;
  return Option.getOrElse(op.description, () =>
    Option.getOrElse(op.summary, () => `${op.method.toUpperCase()} ${op.pathTemplate}`),
  );
};

export interface CompiledOpenApiSpec {
  readonly definitions: readonly ToolDefinition[];
  readonly hoistedDefs: Record<string, unknown>;
  readonly title: string | undefined;
  readonly description: string | undefined;
}

export const compileOpenApiDocument = (
  doc: ParsedDocument,
): Effect.Effect<CompiledOpenApiSpec, OpenApiExtractionError> =>
  Effect.gen(function* () {
    const result = yield* extract(doc);
    const hoistedDefs: Record<string, unknown> = {};
    if (doc.components?.schemas) {
      for (const [k, v] of Object.entries(doc.components.schemas)) {
        hoistedDefs[k] = normalizeOpenApiRefs(v);
      }
    }
    return {
      definitions: compileToolDefinitions(result.operations),
      hoistedDefs,
      title: Option.getOrUndefined(result.title),
      description: Option.getOrUndefined(result.description),
    };
  });

export const compileOpenApiSpec = (
  specText: string,
): Effect.Effect<CompiledOpenApiSpec, OpenApiParseError | OpenApiExtractionError> =>
  Effect.gen(function* () {
    const doc = yield* parse(specText);
    return yield* compileOpenApiDocument(doc);
  });

export const openApiToolDefsFromCompiled = (compiled: CompiledOpenApiSpec): readonly ToolDef[] =>
  compiled.definitions.map(
    (def): ToolDef => ({
      name: ToolName.make(def.toolPath),
      description: descriptionFor(def),
      inputSchema: normalizeOpenApiRefs(Option.getOrUndefined(def.operation.inputSchema)),
      outputSchema: Option.match(def.operation.responseBody, {
        onNone: () => normalizeOpenApiRefs(Option.getOrUndefined(def.operation.outputSchema)),
        onSome: (responseBody) =>
          Option.isSome(responseBody.fileHint)
            ? ToolFileJsonSchema
            : normalizeOpenApiRefs(Option.getOrUndefined(def.operation.outputSchema)),
      }),
      annotations: annotationsForOperation(def.operation.method, def.operation.pathTemplate),
    }),
  );

export const openApiStoredOperationsFromCompiled = (
  integration: string,
  compiled: CompiledOpenApiSpec,
): readonly StoredOperation[] =>
  compiled.definitions.map((def) => ({
    integration,
    toolName: def.toolPath,
    binding: toBinding(def),
  }));

export const loadOpenApiSpecText = (
  storage: OpenapiStore,
  config: OpenApiIntegrationConfig,
): Effect.Effect<string | null, StorageFailure> =>
  config.specHash != null ? storage.getSpec(config.specHash) : Effect.succeed(null);

export const resolveOpenApiBackedTools = ({
  config,
  storage,
}: {
  readonly config: unknown;
  readonly storage: OpenapiStore;
}): Effect.Effect<ResolveToolsResult, StorageFailure> =>
  Effect.gen(function* () {
    const openApiConfig = decodeOpenApiIntegrationConfig(config);
    if (!openApiConfig) return { tools: [], definitions: {} };
    const specText = yield* loadOpenApiSpecText(storage, openApiConfig);
    if (specText == null) return { tools: [], definitions: {} };
    const compiled = yield* compileOpenApiSpec(specText).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (!compiled) return { tools: [], definitions: {} };
    return {
      tools: openApiToolDefsFromCompiled(compiled),
      definitions: compiled.hoistedDefs,
    };
  });

export const invokeOpenApiBackedTool = (input: {
  readonly ctx: PluginCtx<OpenapiStore>;
  readonly toolRow: { readonly integration: string; readonly name: string };
  readonly credential: ToolInvocationCredential;
  readonly args: unknown;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient, never, never>;
}) =>
  Effect.gen(function* () {
    const integration = input.toolRow.integration;
    const config = decodeOpenApiIntegrationConfig(input.credential.config);

    let binding = (yield* input.ctx.storage.getOperation(integration, input.toolRow.name))?.binding;
    if ((!binding || Option.isNone(binding.responseBody)) && config) {
      const specText = yield* loadOpenApiSpecText(input.ctx.storage, config).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      const compiled =
        specText == null
          ? null
          : yield* compileOpenApiSpec(specText).pipe(Effect.catch(() => Effect.succeed(null)));
      binding = compiled
        ? openApiStoredOperationsFromCompiled(integration, compiled).find(
            (op) => op.toolName === input.toolRow.name,
          )?.binding
        : undefined;
    }
    if (!binding) {
      return yield* new OpenApiExtractionError({
        message: `No OpenAPI operation found for tool "${input.toolRow.name}" on "${integration}"`,
      });
    }

    const headers: Record<string, string> = { ...(config?.headers ?? {}) };
    const queryParams: Record<string, string> = {
      ...(config?.queryParams ?? {}),
    };

    const template = (config?.authenticationTemplate ?? []).find(
      (entry) => String(entry.slug) === String(input.credential.template),
    );
    if (template) {
      const missing = requiredTemplateVariables(template).filter((name) => {
        const value = input.credential.values[name];
        return value == null || value === "";
      });
      if (missing.length > 0) {
        return openApiAuthToolFailure({
          code:
            template.kind === "oauth2" ? "oauth_connection_missing" : "connection_value_missing",
          message: `Connection "${input.credential.connection}" for "${integration}" has no resolvable credential value. Re-authenticate or update the connection.`,
          owner: input.credential.owner,
          integration,
          connection: String(input.credential.connection),
          credentialKind: template.kind === "oauth2" ? "oauth" : "secret",
        });
      }
      const rendered = renderAuthTemplate(template, input.credential.values);
      Object.assign(headers, rendered.headers);
      Object.assign(queryParams, rendered.queryParams);
    }

    const result = yield* invokeWithLayer(
      binding,
      (input.args ?? {}) as Record<string, unknown>,
      config?.baseUrl ?? "",
      headers,
      queryParams,
      input.httpClientLayer,
    );

    const ok = result.status >= 200 && result.status < 300;
    if (!ok) {
      if (result.status === 401 || result.status === 403) {
        return openApiAuthToolFailure({
          code: "connection_rejected",
          status: result.status,
          message: `Upstream rejected credentials for "${integration}" with HTTP ${result.status}. Re-authenticate or update the connection "${input.credential.connection}" before retrying this tool.`,
          owner: input.credential.owner,
          integration,
          connection: String(input.credential.connection),
          credentialKind: "upstream",
          credentialLabel: "Upstream authorization",
          details: result.error,
        });
      }
      return ToolResult.fail({
        code: "upstream_http_error",
        status: result.status,
        message: extractOpenApiUpstreamMessage(result.error, result.status),
        details: result.error,
      });
    }
    return ToolResult.ok(result.data, {
      http: { status: result.status, headers: result.headers },
    });
  });

export const resolveOpenApiBackedAnnotations = (input: {
  readonly ctx: PluginCtx<OpenapiStore>;
  readonly integration: string;
  readonly toolRows: readonly { readonly name: string }[];
}) =>
  Effect.gen(function* () {
    const ops = yield* input.ctx.storage.listOperations(String(input.integration));
    const byName = new Map<string, OperationBinding>();
    for (const op of ops) byName.set(op.toolName, op.binding);
    const out: Record<string, ReturnType<typeof annotationsForOperation>> = {};
    for (const row of input.toolRows) {
      const binding = byName.get(row.name);
      if (binding) {
        out[row.name] = annotationsForOperation(binding.method, binding.pathTemplate);
      }
    }
    return out;
  });

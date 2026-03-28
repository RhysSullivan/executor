import {
  ElicitRequestSchema,
  UrlElicitationRequiredError,
} from "@modelcontextprotocol/sdk/types.js";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";

import type {
  ElicitationRequest,
  ElicitationResponse,
  ToolExecutionContext,
  ToolPath,
} from "@executor/codemode-core";

const UnknownRecordSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

const decodeUnknownRecordOption = Schema.decodeUnknownOption(UnknownRecordSchema);

export const readUnknownRecord = (input: unknown): Record<string, unknown> => {
  const decoded = decodeUnknownRecordOption(input);
  return Option.isSome(decoded) ? decoded.value : {};
};

const RawMcpElicitationParamsSchema = Schema.Struct({
  mode: Schema.optional(Schema.Union(Schema.Literal("form"), Schema.Literal("url"))),
  message: Schema.optional(Schema.String),
  requestedSchema: Schema.optional(UnknownRecordSchema),
  url: Schema.optional(Schema.String),
  elicitationId: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
});

const decodeMcpElicitationParamsEither = Schema.decodeUnknownEither(
  RawMcpElicitationParamsSchema,
);

export const readMcpElicitationRequest = (input: unknown): ElicitationRequest => {
  const decoded = decodeMcpElicitationParamsEither(input);
  if (Either.isLeft(decoded)) {
    throw new Error(
      `Invalid MCP elicitation request params: ${ParseResult.TreeFormatter.formatErrorSync(decoded.left)}`,
    );
  }

  const params = decoded.right;
  const message = params.message ?? "";

  if (params.mode === "url") {
    return {
      mode: "url",
      message,
      url: params.url ?? "",
      elicitationId: params.elicitationId ?? params.id ?? "",
    };
  }

  return {
    mode: "form",
    message,
    requestedSchema: params.requestedSchema ?? {},
  };
};

export const toMcpElicitationResponse = (
  response: ElicitationResponse,
): { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> } =>
  response.action === "accept"
    ? {
        action: "accept",
        ...(response.content ? { content: response.content } : {}),
      }
    : { action: response.action };

type McpClientWithElicitationHandler = {
  setRequestHandler: (
    schema: typeof ElicitRequestSchema,
    handler: (request: { params: unknown }) => Promise<unknown>,
  ) => void;
};

export const hasElicitationRequestHandler = (
  value: unknown,
): value is McpClientWithElicitationHandler =>
  typeof (value as { setRequestHandler?: unknown }).setRequestHandler === "function";

export const createInteractionId = (input: {
  path: ToolPath;
  invocation?: ToolExecutionContext["invocation"];
  elicitation: ElicitationRequest;
  sequence?: number;
}): string => {
  if (input.elicitation.mode === "url" && input.elicitation.elicitationId.length > 0) {
    return input.elicitation.elicitationId;
  }

  const parts = [
    input.invocation?.runId,
    input.invocation?.callId,
    input.path,
    "mcp",
    typeof input.sequence === "number" ? String(input.sequence) : undefined,
  ].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );

  return parts.join(":");
};

export const isUrlElicitationRequiredError = (
  cause: unknown,
): cause is UrlElicitationRequiredError =>
  cause instanceof UrlElicitationRequiredError
  && Array.isArray(cause.elicitations)
  && cause.elicitations.length > 0;

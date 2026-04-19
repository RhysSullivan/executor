import * as Effect from "effect/Effect";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const TOOL_PATH_TOKEN = /^[A-Za-z0-9._-]+$/;

const toToolPathSegments = (parts: ReadonlyArray<string>): ReadonlyArray<string> =>
  parts
    .flatMap((part) => part.split("."))
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

export const buildToolPath = (parts: ReadonlyArray<string>): string => {
  const segments = toToolPathSegments(parts);
  if (segments.length === 0) {
    throw new Error("Tool path must include at least one segment");
  }
  return segments.join(".");
};

export const isLikelyToolPathToken = (raw: string): boolean => {
  const value = raw.trim();
  return value.length > 0 && TOOL_PATH_TOKEN.test(value);
};

const buildToolAccessExpression = (toolPath: string): string => {
  const segments = toToolPathSegments([toolPath]);
  if (segments.length === 0) {
    throw new Error("Tool path must include at least one segment");
  }
  return segments.map((segment) => `[${JSON.stringify(segment)}]`).join("");
};

export const parseJsonObjectInput = (
  raw: string | undefined,
): Effect.Effect<Record<string, unknown>, Error> =>
  Effect.gen(function* () {
    if (raw === undefined || raw.trim().length === 0) {
      return {};
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as unknown,
      catch: (cause) =>
        cause instanceof Error
          ? new Error(`Invalid JSON arguments: ${cause.message}`)
          : new Error(`Invalid JSON arguments: ${String(cause)}`),
    });

    if (!isRecord(parsed)) {
      return yield* Effect.fail(new Error("Tool arguments must decode to a JSON object"));
    }

    return parsed;
  });

export const extractExecutionResult = (structured: unknown): unknown => {
  if (!isRecord(structured) || !("result" in structured)) {
    return null;
  }
  return structured.result;
};

export const extractExecutionId = (structured: unknown): string | undefined => {
  if (!isRecord(structured) || typeof structured.executionId !== "string") {
    return undefined;
  }
  return structured.executionId;
};

export const buildSearchToolsCode = (input: {
  query: string;
  namespace?: string;
  limit: number;
}): string => {
  const payload: Record<string, unknown> = {
    query: input.query,
    limit: input.limit,
  };
  if (input.namespace && input.namespace.trim().length > 0) {
    payload.namespace = input.namespace;
  }
  return `return await tools.search(${JSON.stringify(payload)});`;
};

export const buildListSourcesCode = (input: { query?: string; limit: number }): string => {
  const payload: Record<string, unknown> = {
    limit: input.limit,
  };
  if (input.query && input.query.trim().length > 0) {
    payload.query = input.query;
  }
  return `return await tools.executor.sources.list(${JSON.stringify(payload)});`;
};

export const buildDescribeToolCode = (toolPath: string): string =>
  `return await tools.describe.tool({ path: ${JSON.stringify(toolPath)} });`;

export const buildInvokeToolCode = (toolPath: string, args: Record<string, unknown>): string => {
  const access = buildToolAccessExpression(toolPath);
  return [
    `const __toolPath = ${JSON.stringify(toolPath)};`,
    `const __args = ${JSON.stringify(args, null, 2)};`,
    `const __target = tools${access};`,
    `if (typeof __target !== "function") {`,
    "  throw new Error(`Tool not found: ${__toolPath}`);",
    "}",
    "return await __target(__args);",
  ].join("\n");
};

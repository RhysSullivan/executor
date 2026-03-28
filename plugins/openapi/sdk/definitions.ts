import type {
  OpenApiExtractedTool,
  OpenApiToolDefinition,
  OpenApiToolManifest,
  OpenApiToolProviderData,
} from "./types";

const VERSION_SEGMENT_REGEX = /^v\d+(?:[._-]\d+)?$/i;
const IGNORED_PATH_SEGMENTS = new Set(["api"]);

const splitWords = (value: string): Array<string> =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z0-9]+)/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);

const normalizeWord = (value: string): string => value.toLowerCase();

const toCamelCase = (value: string): string => {
  const words = splitWords(value).map(normalizeWord);
  if (words.length === 0) {
    return "tool";
  }

  const [first, ...rest] = words;
  return `${first}${rest
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("")}`;
};

const toPascalCase = (value: string): string => {
  const camel = toCamelCase(value);
  return `${camel[0]?.toUpperCase() ?? ""}${camel.slice(1)}`;
};

const normalizeGroupSegment = (value: string | undefined): string | null => {
  const candidate = value?.trim();
  if (!candidate) {
    return null;
  }

  return toCamelCase(candidate);
};

const pathSegmentsFromTemplate = (pathTemplate: string): Array<string> =>
  pathTemplate
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

const isPathParameterSegment = (segment: string): boolean =>
  segment.startsWith("{") && segment.endsWith("}");

const deriveVersionSegment = (pathTemplate: string): string | undefined =>
  pathSegmentsFromTemplate(pathTemplate)
    .map((segment) => segment.toLowerCase())
    .find((segment) => VERSION_SEGMENT_REGEX.test(segment));

const derivePathGroup = (pathTemplate: string): string => {
  for (const segment of pathSegmentsFromTemplate(pathTemplate)) {
    const lower = segment.toLowerCase();
    if (VERSION_SEGMENT_REGEX.test(lower)) {
      continue;
    }
    if (IGNORED_PATH_SEGMENTS.has(lower)) {
      continue;
    }
    if (isPathParameterSegment(segment)) {
      continue;
    }

    return normalizeGroupSegment(segment) ?? "root";
  }

  return "root";
};

const splitOperationIdSegments = (value: string): Array<string> =>
  value
    .split(/[/.]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

const deriveLeafSeed = (
  tool: OpenApiExtractedTool,
  group: string,
): string => {
  const preferredSource = tool.operationId ?? tool.toolId;
  const segments = splitOperationIdSegments(preferredSource);
  if (segments.length > 1) {
    const [first, ...rest] = segments;
    if ((normalizeGroupSegment(first) ?? first) === group && rest.length > 0) {
      return rest.join(" ");
    }
  }

  return preferredSource;
};

const fallbackLeafSeed = (
  tool: OpenApiExtractedTool,
  group: string,
): string => {
  const relevantSegments = pathSegmentsFromTemplate(tool.path)
    .filter((segment) => !VERSION_SEGMENT_REGEX.test(segment.toLowerCase()))
    .filter((segment) => !IGNORED_PATH_SEGMENTS.has(segment.toLowerCase()))
    .filter((segment) => !isPathParameterSegment(segment))
    .map((segment) => normalizeGroupSegment(segment) ?? segment)
    .filter((segment) => segment !== group);

  const segmentSuffix = relevantSegments
    .map((segment) => toPascalCase(segment))
    .join("");

  return `${tool.method}${segmentSuffix || "Operation"}`;
};

const deriveLeaf = (tool: OpenApiExtractedTool, group: string): string => {
  const preferred = toCamelCase(deriveLeafSeed(tool, group));
  if (preferred.length > 0 && preferred !== group) {
    return preferred;
  }

  return toCamelCase(fallbackLeafSeed(tool, group));
};

const defaultDescription = (tool: OpenApiExtractedTool): string =>
  tool.description ?? `${tool.method.toUpperCase()} ${tool.path}`;

const withResolvedToolIds = (
  definitions: Array<Omit<OpenApiToolDefinition, "toolId">>,
): Array<OpenApiToolDefinition> => {
  const staged = definitions.map((definition) => ({
    ...definition,
    toolId: `${definition.group}.${definition.leaf}`,
  }));

  const applyCandidates = (
    candidates: Array<OpenApiToolDefinition>,
    factory: (definition: OpenApiToolDefinition) => string,
  ) => {
    const byToolId = new Map<string, Array<OpenApiToolDefinition>>();
    for (const candidate of candidates) {
      const bucket = byToolId.get(candidate.toolId) ?? [];
      bucket.push(candidate);
      byToolId.set(candidate.toolId, bucket);
    }

    for (const bucket of byToolId.values()) {
      if (bucket.length < 2) {
        continue;
      }

      for (const definition of bucket) {
        definition.toolId = factory(definition);
      }
    }
  };

  applyCandidates(staged, (definition) =>
    definition.versionSegment
      ? `${definition.group}.${definition.versionSegment}.${definition.leaf}`
      : definition.toolId,
  );

  applyCandidates(staged, (definition) => {
    const prefix = definition.versionSegment
      ? `${definition.group}.${definition.versionSegment}`
      : definition.group;
    return `${prefix}.${definition.leaf}${toPascalCase(definition.method)}`;
  });

  applyCandidates(staged, (definition) => {
    const prefix = definition.versionSegment
      ? `${definition.group}.${definition.versionSegment}`
      : definition.group;
    return `${prefix}.${definition.leaf}${toPascalCase(
      definition.method,
    )}${definition.operationHash.slice(0, 8)}`;
  });

  return staged;
};

export const compileOpenApiToolDefinitions = (
  manifest: OpenApiToolManifest,
): Array<OpenApiToolDefinition> => {
  const definitions = manifest.tools.map((tool) => {
    const group =
      normalizeGroupSegment(tool.tags[0]) ?? derivePathGroup(tool.path);
    const leaf = deriveLeaf(tool, group);

    return {
      rawToolId: tool.toolId,
      operationId: tool.operationId,
      name: tool.name,
      description: defaultDescription(tool),
      group,
      leaf,
      tags: [...tool.tags],
      versionSegment: deriveVersionSegment(tool.path),
      method: tool.method,
      path: tool.path,
      invocation: tool.invocation,
      operationHash: tool.operationHash,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      documentation: tool.documentation,
      responses: tool.responses,
      authRequirement: tool.authRequirement,
      securitySchemes: tool.securitySchemes,
      documentServers: tool.documentServers,
      servers: tool.servers,
    } satisfies Omit<OpenApiToolDefinition, "toolId">;
  });

  return withResolvedToolIds(definitions).sort(
    (left, right) =>
      left.toolId.localeCompare(right.toolId) ||
      left.rawToolId.localeCompare(right.rawToolId) ||
      left.operationHash.localeCompare(right.operationHash),
  );
};

export const openApiProviderDataFromDefinition = (
  definition: OpenApiToolDefinition,
): OpenApiToolProviderData => ({
  kind: "openapi",
  toolId: definition.toolId,
  rawToolId: definition.rawToolId,
  operationId: definition.operationId,
  group: definition.group,
  leaf: definition.leaf,
  tags: definition.tags,
  versionSegment: definition.versionSegment,
  method: definition.method,
  path: definition.path,
  operationHash: definition.operationHash,
  invocation: definition.invocation,
  documentation: definition.documentation,
  responses: definition.responses,
  authRequirement: definition.authRequirement,
  securitySchemes: definition.securitySchemes,
  documentServers: definition.documentServers,
  servers: definition.servers,
});

import { hoistDefinitions, normalizeRefs } from "./schema-refs";

type JsonSchemaRecord = Record<string, unknown>;
type CompilerJsonSchema = JsonSchemaRecord | boolean;
type CompilerFormatOptions = {
  [key: string]: unknown;
  printWidth?: number;
  semi?: boolean;
  singleQuote?: boolean;
  trailingComma?: "none" | "es5" | "all";
};
type SchemaCompilerOptions = {
  [key: string]: unknown;
  additionalProperties?: boolean;
  bannerComment?: string;
  enableConstEnums?: boolean;
  format?: boolean;
  style?: CompilerFormatOptions;
  unknownAny?: boolean;
  unreachableDefinitions?: boolean;
};
type SchemaCompiler = {
  compile: (
    schema: CompilerJsonSchema,
    name: string,
    options: Partial<SchemaCompilerOptions>,
  ) => Promise<string>;
};

export type TypeScriptRenderOptions = {
  compilerOptions?: Partial<SchemaCompilerOptions>;
};

export type TypeScriptSchemaPreview = {
  readonly type: string;
  readonly definitions: Record<string, string>;
};

const ROOT_WRAPPER_NAME = "SchemaPreview";
const ROOT_PROPERTY_NAME = "__root";

const DEFAULT_COMPILER_OPTIONS = {
  additionalProperties: false,
  bannerComment: "",
  enableConstEnums: false,
  format: false,
  unknownAny: true,
  unreachableDefinitions: false,
  style: {
    printWidth: 120,
    semi: true,
    singleQuote: false,
    trailingComma: "none",
  },
} satisfies Partial<SchemaCompilerOptions>;

const schemaCompilerModulePath = (): string =>
  import.meta.url.endsWith(".ts")
    ? "./vendor/json-schema-to-typescript/index.ts"
    : "./vendor/json-schema-to-typescript/index.js";

const loadSchemaCompiler = async (): Promise<SchemaCompiler> => {
  const compilerModule: unknown = await import(schemaCompilerModulePath());
  return compilerModule as SchemaCompiler;
};

const DEFINITION_REF_PATTERN = /^#\/definitions\/(.+)$/;

const asRecord = (value: unknown): JsonSchemaRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonSchemaRecord)
    : {};

const asCompilerSchema = (value: unknown): CompilerJsonSchema => {
  if (typeof value === "boolean") {
    return value;
  }

  if (value !== null && typeof value === "object") {
    return value as JsonSchemaRecord;
  }

  return {};
};

const isNullSchema = (value: unknown): boolean => {
  if (value === false) {
    return false;
  }

  const schema = asRecord(value);
  return schema.type === "null" || schema.const === null;
};

const appendNullSchema = (schemas: ReadonlyArray<unknown>): Array<unknown> =>
  schemas.some(isNullSchema) ? [...schemas] : [...schemas, { type: "null" }];

const schemaAlreadyAllowsNull = (schema: JsonSchemaRecord): boolean => {
  if (schema.type === "null" || schema.const === null) {
    return true;
  }

  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    return true;
  }

  if (Array.isArray(schema.enum) && schema.enum.includes(null)) {
    return true;
  }

  const compositeSchemas = [
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
  ];
  return compositeSchemas.some(isNullSchema);
};

const normalizeNullable = (schema: JsonSchemaRecord): JsonSchemaRecord => {
  if (schema.nullable !== true) {
    return schema;
  }

  const { nullable: _nullable, ...base } = schema;
  if (schemaAlreadyAllowsNull(base)) {
    return base;
  }

  if ("const" in base) {
    const { const: constValue, type: _type, ...rest } = base;
    return { ...rest, enum: [constValue, null] };
  }

  if (Array.isArray(base.enum)) {
    return { ...base, enum: [...base.enum, null] };
  }

  if (typeof base.type === "string") {
    return { ...base, type: [base.type, "null"] };
  }

  if (Array.isArray(base.type)) {
    const types = base.type.filter(
      (value): value is string => typeof value === "string",
    );
    return types.length > 0
      ? { ...base, type: [...types, "null"] }
      : { anyOf: [base, { type: "null" }] };
  }

  if (Array.isArray(base.oneOf)) {
    return { ...base, oneOf: appendNullSchema(base.oneOf) };
  }

  if (Array.isArray(base.anyOf)) {
    return { ...base, anyOf: appendNullSchema(base.anyOf) };
  }

  return { anyOf: [base, { type: "null" }] };
};

const normalizeSchema = (node: unknown): unknown => {
  if (node === null || typeof node !== "object") {
    return node;
  }

  if (Array.isArray(node)) {
    return node.map((item) => normalizeSchema(item));
  }

  const schema = node as JsonSchemaRecord;
  const normalized: JsonSchemaRecord = {};

  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref" && typeof value === "string") {
      const definitionName = value.match(DEFINITION_REF_PATTERN)?.[1];
      normalized[key] = definitionName ? `#/$defs/${definitionName}` : value;
      continue;
    }

    normalized[key] = normalizeSchema(value);
  }

  return normalizeNullable(normalized);
};

const mergeDefinitions = (
  externalDefs: ReadonlyMap<string, unknown>,
  localDefs: Record<string, unknown>,
): Record<string, unknown> => {
  const merged: Record<string, unknown> = {};

  for (const [name, schema] of externalDefs) {
    merged[name] = normalizeSchema(normalizeRefs(asCompilerSchema(schema)));
  }

  for (const [name, schema] of Object.entries(localDefs)) {
    merged[name] = normalizeSchema(normalizeRefs(asCompilerSchema(schema)));
  }

  return merged;
};

const buildWrappedObjectSchema = (
  properties: ReadonlyArray<readonly [string, unknown]>,
  defs: ReadonlyMap<string, unknown>,
): JsonSchemaRecord => {
  const normalizedProperties: Record<string, unknown> = {};
  const localDefs: Record<string, unknown> = {};

  for (const [name, schema] of properties) {
    const normalizedSchema = normalizeSchema(
      normalizeRefs(asCompilerSchema(schema)),
    );
    const { stripped, defs: schemaDefs } = hoistDefinitions(normalizedSchema);
    normalizedProperties[name] = asCompilerSchema(stripped);
    Object.assign(localDefs, schemaDefs);
  }

  const mergedDefs = mergeDefinitions(defs, localDefs);
  const wrappedSchema: JsonSchemaRecord = {
    type: "object",
    properties: normalizedProperties,
    required: properties.map(([name]) => name),
    additionalProperties: false,
  };

  if (Object.keys(mergedDefs).length > 0) {
    wrappedSchema.$defs = mergedDefs;
  }

  return wrappedSchema;
};

const buildWrappedSchema = (
  schema: unknown,
  defs: ReadonlyMap<string, unknown>,
): JsonSchemaRecord =>
  buildWrappedObjectSchema([[ROOT_PROPERTY_NAME, schema]], defs);

const buildNamedSchema = (
  schema: unknown,
  defs: ReadonlyMap<string, unknown>,
): CompilerJsonSchema => buildWrappedSchema(schema, defs);

const compilerOptionsFrom = (
  options: TypeScriptRenderOptions,
): Partial<SchemaCompilerOptions> => ({
  ...DEFAULT_COMPILER_OPTIONS,
  ...options.compilerOptions,
  bannerComment: "",
  format: false,
  style: {
    ...DEFAULT_COMPILER_OPTIONS.style,
    ...options.compilerOptions?.style,
  },
});

const compileSchemaPreview = async (
  schema: unknown,
  defs: ReadonlyMap<string, unknown>,
  options: TypeScriptRenderOptions,
): Promise<TypeScriptSchemaPreview> => {
  const wrappedSchema = buildNamedSchema(schema, defs);
  const { compile } = await loadSchemaCompiler();
  const source = await compile(
    wrappedSchema,
    ROOT_WRAPPER_NAME,
    compilerOptionsFrom(options),
  );
  return { type: source.trim(), definitions: {} };
};

export const schemaToTypeScriptPreview = (
  schema: unknown,
  options: TypeScriptRenderOptions = {},
): Promise<TypeScriptSchemaPreview> => {
  const localDefs = new Map<string, unknown>(
    Object.entries(hoistDefinitions(asCompilerSchema(schema)).defs),
  );
  return schemaToTypeScriptPreviewWithDefs(schema, localDefs, options);
};

export const schemaToTypeScriptPreviewWithDefs = (
  schema: unknown,
  defs: ReadonlyMap<string, unknown>,
  options: TypeScriptRenderOptions = {},
): Promise<TypeScriptSchemaPreview> =>
  compileSchemaPreview(schema, defs, options).then(
    (preview) => preview,
    () => ({
      type: "unknown",
      definitions: {},
    }),
  );

export type ToolTypeScriptPreview = {
  inputTypeScript?: string;
  outputTypeScript?: string;
  typeScriptDefinitions?: Record<string, string>;
};

export const buildToolTypeScriptPreview = async (input: {
  inputSchema?: unknown;
  outputSchema?: unknown;
  defs: ReadonlyMap<string, unknown>;
  options?: TypeScriptRenderOptions;
}): Promise<ToolTypeScriptPreview> => {
  if (input.inputSchema === undefined && input.outputSchema === undefined) {
    return {};
  }

  const { compile } = await loadSchemaCompiler();
  const compilerOptions = compilerOptionsFrom(input.options ?? {});
  const [inputTypeScript, outputTypeScript] = await Promise.all([
    input.inputSchema !== undefined
      ? compile(
          buildNamedSchema(input.inputSchema, input.defs),
          "Input",
          compilerOptions,
        )
      : Promise.resolve(undefined),
    input.outputSchema !== undefined
      ? compile(
          buildNamedSchema(input.outputSchema, input.defs),
          "Output",
          compilerOptions,
        )
      : Promise.resolve(undefined),
  ]);

  return {
    ...(inputTypeScript ? { inputTypeScript: inputTypeScript.trim() } : {}),
    ...(outputTypeScript ? { outputTypeScript: outputTypeScript.trim() } : {}),
  };
};

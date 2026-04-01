import { JSONSchema, SchemaAST } from "effect";
import { Option } from "effect";
import type { JsonSchema7, JsonSchema7Root } from "effect/JSONSchema";
import type { LiveCatalog, SerializedCatalog } from "./registry";

function getSchemaIdentifier(schema: { ast: SchemaAST.AST }): string | undefined {
  return Option.getOrUndefined(SchemaAST.getJSONIdentifier(schema.ast));
}

export function serialize(catalog: LiveCatalog): typeof SerializedCatalog.Type {
  const defs: Record<string, JsonSchema7> = {};

  function schemaToRef(schema: { ast: SchemaAST.AST } | undefined): string | undefined {
    if (!schema) return undefined;

    const identifier = getSchemaIdentifier(schema);
    const jsonSchema = JSONSchema.fromAST(schema.ast, {
      definitions: defs,
      target: "jsonSchema2020-12",
    });

    if (identifier) {
      return identifier;
    }

    // Inline schema without an identifier — store under a generated key
    const key = `__inline_${Object.keys(defs).length}`;
    defs[key] = jsonSchema;
    return key;
  }

  const tools = catalog.tools.map((tool) => ({
    path: tool.path,
    description: tool.description,
    sourceId: tool.sourceId,
    input: schemaToRef(tool.input),
    output: schemaToRef(tool.output),
    error: schemaToRef(tool.error),
  }));

  return {
    version: "v4.1" as const,
    types: defs as Record<string, unknown>,
    tools,
  };
}

export function deserializeToJsonSchema(
  serialized: typeof SerializedCatalog.Type,
): {
  tools: ReadonlyArray<{
    path: string;
    description?: string;
    tags?: ReadonlyArray<string>;
    namespace?: string;
    input?: JsonSchema7Root;
    output?: JsonSchema7Root;
    error?: JsonSchema7Root;
  }>;
  types: Record<string, unknown>;
} {
  const types = serialized.types;

  function resolveRef(ref: string | undefined): JsonSchema7Root | undefined {
    if (!ref) return undefined;
    const schema = types[ref];
    if (!schema) return undefined;
    return {
      ...(schema as JsonSchema7Root),
      $defs: types as Record<string, JsonSchema7>,
    };
  }

  return {
    tools: serialized.tools.map((tool) => ({
      path: tool.path,
      description: tool.description,
      sourceId: tool.sourceId,
      input: resolveRef(tool.input),
      output: resolveRef(tool.output),
      error: resolveRef(tool.error),
    })),
    types,
  };
}

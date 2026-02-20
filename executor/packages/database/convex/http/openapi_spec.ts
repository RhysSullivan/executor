export type FunctionType = "query" | "mutation" | "action";

const CONTROL_QUERY_PARAMS = new Set(["format", "args", "path", "function", "type"]);

export type ValidatorJson = {
  type: string;
  [key: string]: unknown;
};

export type OpenApiFunctionSpec = {
  identifier: string;
  functionType: FunctionType;
  method: "GET" | "POST";
  args?: ValidatorJson | string | null;
  returns?: ValidatorJson | string | null;
};

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function schemaId(identifier: string): string {
  return identifier.replace(/[^a-zA-Z0-9_]/g, "_");
}

function endpointPath(identifier: string): string {
  const [modulePath, exportName] = identifier.split(":");
  if (!modulePath || !exportName) {
    return `/api/run/${identifier.replace(/:/g, "/")}`;
  }
  return `/api/run/${modulePath}/${exportName}`;
}

function buildGetParametersFromArgsSchema(argsSchema: Record<string, unknown>): Array<Record<string, unknown>> {
  const schemaType = typeof argsSchema.type === "string" ? argsSchema.type : undefined;
  const properties = toRecord(argsSchema.properties);
  const required = Array.isArray(argsSchema.required)
    ? new Set(argsSchema.required.filter((entry): entry is string => typeof entry === "string"))
    : new Set<string>();

  if (schemaType !== "object" || Object.keys(properties).length === 0) {
    return [{
      in: "query",
      name: "args",
      required: false,
      schema: {
        type: "string",
        description: "JSON-encoded args object",
      },
    }];
  }

  const parameters: Array<Record<string, unknown>> = [];
  for (const [name, value] of Object.entries(properties)) {
    if (CONTROL_QUERY_PARAMS.has(name)) {
      continue;
    }

    parameters.push({
      in: "query",
      name,
      required: required.has(name),
      schema: toRecord(value),
    });
  }

  return parameters;
}

export function schemaFromValidator(validator?: ValidatorJson | string | null): Record<string, unknown> {
  if (typeof validator === "string") {
    try {
      const parsed = JSON.parse(validator) as ValidatorJson;
      return schemaFromValidator(parsed);
    } catch {
      return {};
    }
  }

  if (!validator || typeof validator !== "object") {
    return {};
  }

  switch (validator.type) {
    case "null":
      return { type: "string", nullable: true };
    case "number":
      return { type: "number" };
    case "bigint":
      return { type: "integer", format: "int64" };
    case "boolean":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "bytes":
      return { type: "string", format: "byte" };
    case "any":
      return {};
    case "literal": {
      const literalValue = validator.value;
      if (typeof literalValue === "string") {
        return { type: "string", enum: [literalValue] };
      }
      if (typeof literalValue === "boolean") {
        return { type: "boolean", enum: [literalValue] };
      }
      return { type: "number", enum: [literalValue] };
    }
    case "id":
      return {
        type: "string",
        description: `ID from table "${String(validator.tableName ?? "unknown")}"`,
      };
    case "array":
      return {
        type: "array",
        items: schemaFromValidator((validator.value as ValidatorJson | undefined) ?? { type: "any" }),
      };
    case "record": {
      const values = validator.values as { fieldType?: ValidatorJson } | undefined;
      return {
        type: "object",
        additionalProperties: schemaFromValidator(values?.fieldType ?? { type: "any" }),
      };
    }
    case "object": {
      const rawMembers = validator.value as Record<string, { fieldType: ValidatorJson; optional?: boolean }> | undefined;
      const members = rawMembers ?? {};
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(members)) {
        properties[key] = schemaFromValidator(value.fieldType);
        if (!value.optional) {
          required.push(key);
        }
      }

      return {
        type: "object",
        ...(required.length > 0 ? { required } : {}),
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
      };
    }
    case "union": {
      const members = Array.isArray(validator.value) ? (validator.value as ValidatorJson[]) : [];
      const hasNull = members.some((member) => member.type === "null");
      const nonNullMembers = members.filter((member) => member.type !== "null");

      if (nonNullMembers.length === 1) {
        return {
          ...schemaFromValidator(nonNullMembers[0]),
          ...(hasNull ? { nullable: true } : {}),
        };
      }

      return {
        ...(hasNull ? { nullable: true } : {}),
        oneOf: nonNullMembers.map((member) => schemaFromValidator(member)),
      };
    }
    default:
      return {};
  }
}

export function buildOpenApiDocument(functions: OpenApiFunctionSpec[], serverUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {
    FailedResponse: {
      type: "object",
      properties: {
        errorMessage: { type: "string" },
        errorData: {},
      },
    },
  };

  for (const fn of functions) {
    const id = schemaId(fn.identifier);
    const requestSchemaName = `Request_${id}`;
    const responseSchemaName = `Response_${id}`;

    const argsSchema = schemaFromValidator(fn.args);
    schemas[requestSchemaName] = argsSchema;
    schemas[responseSchemaName] = schemaFromValidator(fn.returns);

    const path = endpointPath(fn.identifier);
    const method = fn.method.toLowerCase();

    const baseOperation: Record<string, unknown> = {
      summary: `Calls ${fn.functionType} ${fn.identifier}`,
      tags: [fn.functionType],
      operationId: `${fn.functionType}_${id}`,
      responses: {
        "200": {
          description: "Convex executed the request",
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${responseSchemaName}` },
            },
          },
        },
        "400": {
          description: "Invalid request payload",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/FailedResponse" },
            },
          },
        },
        "404": {
          description: "Function not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/FailedResponse" },
            },
          },
        },
        "500": {
          description: "Function execution failed",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/FailedResponse" },
            },
          },
        },
      },
    };

    const operation = fn.method === "POST"
      ? {
          ...baseOperation,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${requestSchemaName}` },
              },
            },
          },
        }
      : {
          ...baseOperation,
          parameters: buildGetParametersFromArgsSchema(argsSchema),
        };

    const existingPath = paths[path] ?? {};
    paths[path] = {
      ...existingPath,
      [method]: operation,
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "Convex API",
      version: "0.0.0",
    },
    servers: [{ url: serverUrl }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "query", description: "Functions that read data" },
      { name: "mutation", description: "Functions that write data" },
      { name: "action", description: "Functions that can call external APIs" },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Use Authorization: Bearer <token>",
        },
      },
      schemas,
    },
  };
}

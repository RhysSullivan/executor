import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import type { StandardSchema } from "./types";
import { unknownInputSchema } from "./types";

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateSchema: false,
  allowUnionTypes: true,
});

addFormats(ajv);

const decodePointerSegment = (segment: string): PropertyKey => {
  const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
  return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
};

const pointerToPath = (pointer: string | undefined): ReadonlyArray<PropertyKey> | undefined => {
  if (!pointer || pointer.length === 0 || pointer === "/") {
    return undefined;
  }

  return pointer
    .split("/")
    .slice(1)
    .filter((segment) => segment.length > 0)
    .map(decodePointerSegment);
};

const toIssueMessage = (error: ErrorObject): string => {
  const keyword = error.keyword.trim();
  const message = (error.message ?? "Invalid value").trim();
  return keyword.length > 0 ? `${keyword}: ${message}` : message;
};

export const standardSchemaFromJsonSchema = (
  schema: unknown,
  options?: {
    vendor?: string;
    fallback?: StandardSchema;
  },
): StandardSchema => {
  try {
    const validate = ajv.compile(schema as Record<string, unknown>);

    return {
      "~standard": {
        version: 1,
        vendor: options?.vendor ?? "json-schema",
        validate: (value: unknown) => {
          const valid = validate(value);
          if (valid) {
            return { value };
          }

          const issues = (validate.errors ?? []).map((error) => ({
            message: toIssueMessage(error),
            path: pointerToPath(error.instancePath),
          }));

          return {
            issues: issues.length > 0 ? issues : [{ message: "Invalid value" }],
          };
        },
      },
    };
  } catch {
    return options?.fallback ?? unknownInputSchema;
  }
};

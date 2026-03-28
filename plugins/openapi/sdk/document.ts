import YAML from "yaml";

import type { OpenApiJsonObject } from "./types";

const isOpenApiJsonObject = (value: unknown): value is OpenApiJsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJsonDocument = (input: string): unknown => JSON.parse(input);

const parseYamlDocument = (input: string): unknown => YAML.parse(input);

const parseDocument = (input: string): unknown => {
  try {
    return parseJsonDocument(input);
  } catch {
    return parseYamlDocument(input);
  }
};

export const parseOpenApiDocument = (input: string): OpenApiJsonObject => {
  const text = input.trim();
  if (text.length === 0) {
    throw new Error("OpenAPI document is empty");
  }

  const parsed = parseDocument(text);
  if (!isOpenApiJsonObject(parsed)) {
    throw new Error("OpenAPI document must parse to an object");
  }

  return parsed;
};

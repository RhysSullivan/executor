import { parse as parseYaml } from "yaml";

const parseJsonDocument = (input: string): unknown => JSON.parse(input);

const parseYamlDocument = (input: string): unknown => parseYaml(input);

export const parseOpenApiDocument = (input: string): unknown => {
  const text = input.trim();
  if (text.length === 0) {
    throw new Error("OpenAPI document is empty");
  }

  try {
    return parseJsonDocument(text);
  } catch {
    try {
      return parseYamlDocument(text);
    } catch (cause) {
      throw new Error(
        `Unable to parse OpenAPI document as JSON or YAML: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }
};

export const fetchOpenApiDocument = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed fetching OpenAPI spec (${response.status})`);
  }

  return response.text();
};

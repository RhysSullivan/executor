import { describe, expect, it } from "vitest";

import { parseOpenApiDocument } from "./document";

describe("openapi-document", () => {
  it("parses JSON OpenAPI document text", () => {
    const parsed = parseOpenApiDocument(
      JSON.stringify({ openapi: "3.1.0", paths: {} }),
    ) as { openapi: string };

    expect(parsed.openapi).toBe("3.1.0");
  });

  it("parses YAML OpenAPI document text", () => {
    const parsed = parseOpenApiDocument([
      "openapi: 3.1.0",
      "paths:",
      "  /health:",
      "    get:",
      "      operationId: health",
      "      responses:",
      "        '200':",
      "          description: ok",
    ].join("\n")) as { openapi: string };

    expect(parsed.openapi).toBe("3.1.0");
  });

  it("fails for empty document", () => {
    expect(() => parseOpenApiDocument("   ")).toThrowError(/OpenAPI document is empty/);
  });
});

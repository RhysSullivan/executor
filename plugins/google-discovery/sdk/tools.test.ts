import { createServer } from "node:http";

import { describe, expect, it } from "@effect/vitest";
import { makeToolInvokerFromTools } from "@executor/codemode-core";

import * as Effect from "effect/Effect";

import {
  buildGoogleDiscoveryToolPresentation,
  createGoogleDiscoveryToolFromDefinition,
} from "./tools";
import {
  compileGoogleDiscoveryToolDefinitions,
  extractGoogleDiscoveryManifest,
} from "./document";

const fetchLiveDiscoveryDocument = async (url: string): Promise<string> => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
};

const withJsonServer = async <T>(handler: (input: {
  baseUrl: string;
  requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>;
}) => Promise<T>): Promise<T> => {
  const requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    requests.push({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });

    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        range: "Sheet1!A1:B2",
        values: [["ok"]],
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve local test server address");
    }
    return await handler({
      baseUrl: `http://127.0.0.1:${address.port}`,
      requests,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
};

describe("google discovery tools", () => {
  it("extracts a real Google Sheets discovery document into compact tools", () =>
    Effect.gen(function* () {
      const discoveryDocument = yield* Effect.tryPromise({
        try: () =>
          fetchLiveDiscoveryDocument(
            "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
          ),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });

      const manifest = yield* extractGoogleDiscoveryManifest(
        "Google Sheets",
        discoveryDocument,
      );
      const definitions = compileGoogleDiscoveryToolDefinitions(manifest);
      const valuesGet = definitions.find(
        (definition) => definition.toolId === "spreadsheets.values.get",
      );

      expect(manifest.service).toBe("sheets");
      expect(manifest.versionName).toBe("v4");
      expect(definitions.length).toBeGreaterThan(10);
      expect(valuesGet).toBeDefined();
      expect(valuesGet?.method).toBe("get");
      expect(JSON.stringify(valuesGet?.inputSchema)).toContain("\"spreadsheetId\"");
      expect(JSON.stringify(valuesGet?.outputSchema)).toContain("\"values\"");
      expect(Object.keys(manifest.schemaRefTable ?? {})).toContain(
        "#/$defs/google/ValueRange",
      );
    }).pipe(Effect.runPromise));

  it("materializes schema refs for projected tool presentation from a real Google discovery document", () =>
    Effect.gen(function* () {
      const discoveryDocument = yield* Effect.tryPromise({
        try: () =>
          fetchLiveDiscoveryDocument(
            "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
          ),
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      });

      const manifest = yield* extractGoogleDiscoveryManifest(
        "Google Sheets",
        discoveryDocument,
      );
      const definitions = compileGoogleDiscoveryToolDefinitions(manifest);
      const batchUpdate = definitions.find(
        (definition) => definition.toolId === "spreadsheets.batchUpdate",
      );

      expect(batchUpdate).toBeDefined();

      const presentation = buildGoogleDiscoveryToolPresentation({
        manifest,
        definition: batchUpdate!,
      });

      expect(presentation.inputTypePreview).toContain("spreadsheetId: string");
      expect(presentation.inputTypePreview).toContain("repeatCell?");
      expect(presentation.outputTypePreview).toContain("spreadsheetId");
      expect(presentation.inputSchema).toMatchObject({
        type: "object",
        properties: {
          spreadsheetId: {
            type: "string",
          },
          body: {
            type: "object",
          },
        },
      });
      expect(JSON.stringify(presentation.inputSchema)).toContain("\"repeatCell\"");
      expect(JSON.stringify(presentation.outputSchema)).toContain("\"spreadsheetId\"");
    }).pipe(Effect.runPromise));

  it("invokes a tool compiled from a real Google discovery document", () =>
    Effect.tryPromise({
      try: async () => {
        const discoveryDocument = await fetchLiveDiscoveryDocument(
          "https://www.googleapis.com/discovery/v1/apis/sheets/v4/rest",
        );
        const manifest = await Effect.runPromise(
          extractGoogleDiscoveryManifest("Google Sheets", discoveryDocument),
        );
        const definitions = compileGoogleDiscoveryToolDefinitions(manifest);
        const valuesGet = definitions.find(
          (definition) => definition.toolId === "spreadsheets.values.get",
        );
        if (!valuesGet) {
          throw new Error("Expected sheets.spreadsheets.values.get to exist");
        }

        await withJsonServer(async ({ baseUrl, requests }) => {
          const tool = createGoogleDiscoveryToolFromDefinition({
            definition: valuesGet,
            service: manifest.service,
            version: manifest.versionName,
            rootUrl: manifest.rootUrl,
            servicePath: manifest.servicePath,
            path: "google.sheets.spreadsheets.values.get",
            sourceKey: "src_google_sheets",
            schemaRefTable: manifest.schemaRefTable,
            baseUrl,
            credentialPlacements: {
              headers: {
                authorization: "Bearer live-test-token",
              },
            },
          });

          const result = await Effect.runPromise(
            makeToolInvokerFromTools({
              tools: {
                "google.sheets.spreadsheets.values.get": tool,
              },
            }).invoke({
              path: "google.sheets.spreadsheets.values.get",
              args: {
                spreadsheetId: "sheet123",
                range: "Sheet1!A1:B2",
                majorDimension: "ROWS",
              },
            }),
          );

          expect(result).toEqual({
            range: "Sheet1!A1:B2",
            values: [["ok"]],
          });
          expect(requests).toHaveLength(1);
          expect(requests[0]?.method).toBe("GET");
          expect(requests[0]?.url).toContain(
            "/v4/spreadsheets/sheet123/values/Sheet1!A1%3AB2",
          );
          expect(requests[0]?.url).toContain("majorDimension=ROWS");
          expect(requests[0]?.headers.authorization).toBe("Bearer live-test-token");
        });
      },
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }));
});

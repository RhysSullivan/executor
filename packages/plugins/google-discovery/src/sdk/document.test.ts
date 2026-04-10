import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { extractGoogleDiscoveryManifest } from "./document";

const fixturePath = resolve(__dirname, "../../fixtures/drive.json");
const fixtureText = readFileSync(fixturePath, "utf8");

describe("Google Discovery document", () => {
  it("extracts methods, refs, and oauth scopes", async () => {
    const manifest = await Effect.runPromise(extractGoogleDiscoveryManifest(fixtureText));

    expect(Option.getOrElse(manifest.title, () => "")).toBe("Google Drive");
    expect(manifest.service).toBe("drive");
    expect(manifest.version).toBe("v3");
    expect(manifest.methods.map((method) => method.toolPath)).toEqual([
      "files.get",
      "files.update",
    ]);
    expect(Object.keys(manifest.schemaDefinitions)).toEqual(["File", "UpdateFileRequest"]);

    const getFile = manifest.methods.find((method) => method.toolPath === "files.get");
    expect(getFile).toBeDefined();
    expect(getFile!.binding.pathTemplate).toBe("files/{fileId}");
    expect(Option.isSome(getFile!.inputSchema)).toBe(true);
    expect(Option.isSome(getFile!.outputSchema)).toBe(true);

    const inputSchema = Option.getOrThrow(getFile!.inputSchema) as Record<string, unknown>;
    const properties = inputSchema.properties as Record<string, unknown>;
    expect(properties.fileId).toMatchObject({ type: "string" });
    expect(properties.prettyPrint).toMatchObject({ type: "boolean" });

    const updateFile = manifest.methods.find((method) => method.toolPath === "files.update");
    expect(updateFile).toBeDefined();
    const updateInputSchema = Option.getOrThrow(updateFile!.inputSchema) as Record<string, unknown>;
    expect(updateInputSchema.properties).toHaveProperty("body");

    const scopes = Option.getOrElse(manifest.oauthScopes, () => ({}));
    expect(Object.keys(scopes)).toContain("https://www.googleapis.com/auth/drive");
    expect(Object.keys(scopes)).toContain("https://www.googleapis.com/auth/drive.readonly");
  });
});

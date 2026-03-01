/**
 * Fetches real OpenAPI specs and generates .d.ts type bundles for the Monaco editor.
 *
 * Usage: bun run scripts/generate-types.ts
 *
 * Outputs:
 *   public/types/<source>.d.ts  — full type bundle per source (served as static asset)
 *   public/types/manifest.json  — metadata about each source (tool count, file size)
 */

import { prepareOpenApiSpec } from "../../../../executor/packages/core/src/openapi-prepare";
import { buildOpenApiToolsFromPrepared } from "../../../../executor/packages/core/src/openapi/tool-builder";
import { buildWorkspaceTypeBundle } from "../../../../executor/packages/core/src/tool-typing/typebundle";
import type { OpenApiToolSourceConfig } from "../../../../executor/packages/core/src/tool/source-types";
import { mkdirSync } from "fs";
import { join, dirname } from "path";

interface SourceSpec {
  name: string;
  label: string;
  icon: string;
  description: string;
  specUrl: string;
  baseUrl?: string;
}

const SOURCES: SourceSpec[] = [
  {
    name: "cloudflare",
    label: "Cloudflare",
    icon: "☁",
    description: "DNS, Workers, R2, KV, Zones, WAF, and more",
    specUrl:
      "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json",
    baseUrl: "https://api.cloudflare.com/client/v4",
  },
  {
    name: "vercel",
    label: "Vercel",
    icon: "▲",
    description: "Deployments, Domains, Environment Variables, Projects",
    specUrl: "https://openapi.vercel.sh/",
    baseUrl: "https://api.vercel.com",
  },
  {
    name: "github",
    label: "GitHub",
    icon: "⬡",
    description: "Repos, Issues, Pull Requests, Actions, Packages",
    specUrl:
      "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    baseUrl: "https://api.github.com",
  },
];

const OUT_DIR = join(
  dirname(new URL(import.meta.url).pathname),
  "../public/types",
);

interface ManifestEntry {
  name: string;
  label: string;
  icon: string;
  description: string;
  toolCount: number;
  fileSizeKb: number;
  file: string;
}

async function processSource(source: SourceSpec) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Processing: ${source.name}`);
  console.log(`${"=".repeat(60)}`);

  // Step 1: Prepare the spec
  console.log("  → Fetching and preparing spec...");
  let spec: string | Record<string, unknown> = source.specUrl;

  if (!/\.json($|[?#])/i.test(source.specUrl)) {
    console.log("  → URL doesn't end in .json, fetching manually...");
    const response = await fetch(source.specUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch spec: ${response.status} ${response.statusText}`,
      );
    }
    spec = (await response.json()) as Record<string, unknown>;
  }

  const prepared = await prepareOpenApiSpec(spec, source.name, {
    includeDts: true,
    profile: "full",
  });

  console.log(`  → DTS status: ${prepared.dtsStatus}`);
  console.log(`  → Servers: ${prepared.servers.join(", ") || "(none)"}`);

  // Step 2: Build tool definitions
  console.log("  → Building tool definitions...");
  const sourceConfig: OpenApiToolSourceConfig = {
    type: "openapi",
    name: source.name,
    spec: source.specUrl,
    baseUrl: source.baseUrl,
  };

  const tools = buildOpenApiToolsFromPrepared(sourceConfig, prepared);
  console.log(`  → Tools built: ${tools.length}`);

  // Step 3: Build .d.ts type bundle
  console.log("  → Building type bundle...");
  const sourceKey = `openapi:${source.name}`;
  const dtsBundle = buildWorkspaceTypeBundle({
    tools,
    openApiDtsBySource: prepared.dts ? { [sourceKey]: prepared.dts } : {},
  });

  const sizeKb = dtsBundle.length / 1024;
  console.log(`  → Bundle size: ${sizeKb.toFixed(1)} KB`);

  return { toolCount: tools.length, dtsBundle, sizeKb };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const manifest: ManifestEntry[] = [];

  for (const source of SOURCES) {
    try {
      const result = await processSource(source);
      const fileName = `${source.name}.d.ts`;
      const outPath = join(OUT_DIR, fileName);
      await Bun.write(outPath, result.dtsBundle);
      console.log(`  ✓ Written: ${outPath}`);

      manifest.push({
        name: source.name,
        label: source.label,
        icon: source.icon,
        description: source.description,
        toolCount: result.toolCount,
        fileSizeKb: Math.round(result.sizeKb),
        file: fileName,
      });
    } catch (err) {
      console.error(`  ✗ Failed to process ${source.name}:`, err);
    }
  }

  // Write manifest
  const manifestPath = join(OUT_DIR, "manifest.json");
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n✓ Manifest: ${manifestPath}`);
  console.log(`\nSummary:`);
  for (const entry of manifest) {
    console.log(
      `  ${entry.label}: ${entry.toolCount} tools, ${entry.fileSizeKb} KB`,
    );
  }
  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

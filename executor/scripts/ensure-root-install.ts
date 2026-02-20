#!/usr/bin/env bun

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const thisDir = resolve(".");
const rootManifest = resolve(thisDir, "..", "package.json");

if (!existsSync(rootManifest)) {
  process.exit(0);
}

const rootManifestData = readFileSync(rootManifest, "utf8");
const root = JSON.parse(rootManifestData) as { name?: string };

if (root.name === "proto-monorepo") {
  console.error("❌ Do not run bun install in executor/.");
  console.error("   Install dependencies from the repo root instead: bun install");
  process.exit(1);
}

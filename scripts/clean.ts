#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const rootTargets = ["node_modules", ".turbo", ".astro", "dist"];
for (const name of rootTargets) {
  const p = path.join(root, name);
  if (fs.existsSync(p)) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      console.log("removed", p);
    } catch (e: any) {
      console.warn("skipped (in use?):", p, "-", e.message);
    }
  }
}

const nestedTargets = new Set(["node_modules", "dist", ".turbo", ".output", ".astro"]);
const nestedGlobs = /\.tsbuildinfo$/;
const searchRoots = ["apps", "packages"];
const maxDepth = 5;

function clean(dir: string, depth: number) {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (nestedTargets.has(entry.name)) {
        try {
          fs.rmSync(full, { recursive: true, force: true });
          console.log("removed", full);
        } catch (e: any) {
          console.warn("skipped (in use?):", full, "-", e.message);
        }
      } else {
        clean(full, depth + 1);
      }
    } else if (entry.isFile() && nestedGlobs.test(entry.name)) {
      try {
        fs.rmSync(full, { force: true });
        console.log("removed", full);
      } catch (e: any) {
        console.warn("skipped (in use?):", full, "-", e.message);
      }
    }
  }
}

for (const dir of searchRoots) {
  clean(path.join(root, dir), 1);
}

#!/usr/bin/env bun
// Fail CI when a frontend file calls a mutation via `useAtomSet(<atom>, { mode: "promise" })`
// without ever passing `reactivityKeys` in the corresponding call args.
//
// The check is intentionally coarse: per-file we count `useAtomSet(...)` sites
// and `reactivityKeys` mentions. A file with N mutation sites must mention
// `reactivityKeys` at least N times. Read-only mutations (probes, previews,
// auth-flow starts) are allow-listed so the convention can be locked in
// without false positives.
//
// Run: `bun run scripts/check-reactivity-keys.ts`
// Exits 1 with a punch list when violations exist.

import { Glob } from "bun";

const ROOTS = ["packages", "apps"];

// Mutations that intentionally do not invalidate any cached query (probes,
// previews, OAuth-flow kickoffs that just open a window).
const READ_ONLY_MUTATIONS = new Set<string>([
  "probeMcpEndpoint",
  "startMcpOAuth",
  "probeGoogleDiscovery",
  "startGoogleDiscoveryOAuth",
  "previewOpenApiSpec",
  "startOpenApiOAuth",
  "resolveSecret",
  "detectSource",
  "getDomainVerificationLink",
]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly mutationVar: string;
}

const violations: Violation[] = [];

const useAtomSetRegex = /useAtomSet\(\s*([A-Za-z_][\w]*)\s*,\s*\{\s*mode:\s*"promise"\s*\}\s*\)/g;

for (const root of ROOTS) {
  const glob = new Glob(`${root}/**/*.{ts,tsx}`);
  for await (const path of glob.scan({ cwd: import.meta.dir + "/.." })) {
    if (path.includes("node_modules") || path.includes(".test.") || path.endsWith(".d.ts")) continue;
    const file = Bun.file(`${import.meta.dir}/../${path}`);
    const text = await file.text();
    if (!text.includes("useAtomSet")) continue;

    const lines = text.split("\n");
    let cursor = 0;
    for (const line of lines) {
      cursor++;
      useAtomSetRegex.lastIndex = 0;
      const match = useAtomSetRegex.exec(line);
      if (!match) continue;
      const mutationVar = match[1] ?? "<unknown>";
      // The variable being declared from useAtomSet is what the file later awaits.
      // Find the binding name to look up the await call.
      const bindingMatch = line.match(/const\s+(\w+)\s*=\s*useAtomSet/);
      const binding = bindingMatch?.[1];

      if (READ_ONLY_MUTATIONS.has(mutationVar)) continue;
      if (!binding) continue;

      // Look for `await <binding>(...)` calls in the rest of the file and
      // check whether the *args object* contains `reactivityKeys`. We scan
      // line-by-line and grow a brace-aware window once we see the call.
      const callRegex = new RegExp(`await\\s+${binding}\\s*\\(`);
      let i = cursor;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (callRegex.test(l)) {
          // Extract the args block from the opening paren until balanced close.
          let depth = 0;
          let started = false;
          let argText = "";
          let j = i;
          while (j < lines.length) {
            const cur = lines[j] ?? "";
            for (const ch of cur) {
              if (ch === "(") {
                depth++;
                started = true;
                continue;
              }
              if (started && ch === ")") {
                depth--;
                if (depth === 0) break;
              }
              if (started) argText += ch;
            }
            if (started && depth === 0) break;
            j++;
            if (j - i > 60) break; // bail on runaway
          }
          if (!argText.includes("reactivityKeys")) {
            violations.push({ file: path, line: i + 1, mutationVar });
          }
          break;
        }
        i++;
        if (i - cursor > 80) break; // give up on this site if the await is far away
      }
    }
  }
}

if (violations.length === 0) {
  console.log("✓ reactivityKeys check passed");
  process.exit(0);
}

console.error(`✗ reactivityKeys check failed — ${violations.length} mutation call(s) missing reactivityKeys:\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line} — ${v.mutationVar}`);
}
console.error(
  `\nEvery write mutation must pass reactivityKeys at the call site.\n` +
    `See packages/react/src/api/reactivity-keys.tsx for canonical key arrays.\n` +
    `If this mutation truly is read-only (probe/preview/OAuth-start), add it to\n` +
    `the READ_ONLY_MUTATIONS allowlist in scripts/check-reactivity-keys.ts.`,
);
process.exit(1);

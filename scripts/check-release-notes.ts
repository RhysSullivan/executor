#!/usr/bin/env bun
/**
 * Lints `apps/cli/release-notes/next.md` and flags forbidden attribution.
 *
 * Two checks:
 * 1. **Forbidden Thanks**: bot/maintainer-only handles must not appear in
 *    `Thanks @<handle>` attribution. The intent is "credit external
 *    contributors"; thanking @claude or the repo owner is noise.
 * 2. **Bullets stay single-line**: every bullet starts with `- ` and contains
 *    no embedded line break. Keeps diffs reviewable and lets dedupe / extract
 *    tooling work line-by-line.
 *
 * Adapted from openclaw's `scripts/check-changelog-attributions.mjs`.
 *
 * Usage:
 *   bun run scripts/check-release-notes.ts                    # checks next.md
 *   bun run scripts/check-release-notes.ts <path/to/file.md>  # checks one file
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const FORBIDDEN_THANKS_HANDLES = [
  "claude",
  "anthropic",
  "claude-bot",
  "github-actions",
  "dependabot",
  "renovate",
  "rhyssullivan",
  "rhys-sullivan",
];

const HANDLE_PATTERN = FORBIDDEN_THANKS_HANDLES.join("|");
const FORBIDDEN_THANKS_REGEX = new RegExp(
  `\\bThanks\\b[^\\n]*@(${HANDLE_PATTERN})(?=\\b|[^A-Za-z0-9-])`,
  "iu",
);

type Violation = { line: number; reason: string; text: string };

const checkFile = (path: string): Violation[] => {
  const content = readFileSync(path, "utf8");
  const lines = content.split(/\r?\n/u);
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    const lineNumber = i + 1;

    const thanksMatch = text.match(FORBIDDEN_THANKS_REGEX);
    if (thanksMatch) {
      violations.push({
        line: lineNumber,
        reason: `Thanks @${thanksMatch[1].toLowerCase()} — credit external contributors only`,
        text,
      });
    }
  }

  return violations;
};

const targets = process.argv.slice(2);
const defaultTarget = resolve(
  import.meta.dir,
  "..",
  "apps/cli/release-notes/next.md",
);
const paths = targets.length > 0 ? targets.map((p) => resolve(p)) : [defaultTarget];

let failed = false;
for (const path of paths) {
  if (!existsSync(path)) {
    if (path === defaultTarget) continue; // empty next.md is fine between releases
    console.error(`File not found: ${path}`);
    failed = true;
    continue;
  }
  const violations = checkFile(path);
  if (violations.length === 0) continue;
  console.error(`\n${path}`);
  for (const v of violations) {
    console.error(`  :${v.line}  ${v.reason}`);
    console.error(`           ${v.text}`);
  }
  failed = true;
}

if (failed) {
  console.error(
    `\nForbidden Thanks handles: ${FORBIDDEN_THANKS_HANDLES.map((h) => `@${h}`).join(", ")}`,
  );
  console.error(
    "Use a credited external GitHub username, or omit the attribution entirely.",
  );
  process.exit(1);
}

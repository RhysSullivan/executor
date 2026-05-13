#!/usr/bin/env bun
/**
 * Verifies every workspace package directory has a `CHANGELOG.md` file.
 *
 * `changesets/action@v1` (the GitHub Action wrapping the Changesets CLI in
 * `release.yml`) reads every workspace package's `CHANGELOG.md` to build
 * the Version Packages PR description. If any is missing, the action
 * crashes with `ENOENT` at release time and blocks the release.
 *
 * The CLI alone (with `changelog: false` in `.changeset/config.json`)
 * doesn't need them — but we run via the Action, which does.
 *
 * The stubs themselves are not user-facing. Canonical release notes are
 * at `apps/cli/release-notes/next.md` and on the GitHub Releases page.
 *
 * Usage:
 *   bun run scripts/check-changelog-stubs.ts        # fail on missing
 *   bun run scripts/check-changelog-stubs.ts --fix  # create missing stubs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

type Pkg = { name?: string; private?: boolean };

const findWorkspacePackages = (): string[] => {
  const root = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  const patterns = root.workspaces ?? [];
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    // Bun.Glob — handles workspace patterns like "packages/*/*", "apps/*"
    for (const match of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: repoRoot })) {
      dirs.add(dirname(resolve(repoRoot, match)));
    }
  }
  return [...dirs].sort();
};

const STUB_TEMPLATE = (name: string) =>
  `# ${name} changelog\n\n` +
  "This file exists for `changesets/action@v1` compatibility (it reads every\n" +
  "workspace package's `CHANGELOG.md` to build the Version Packages PR).\n" +
  "Canonical user-facing release notes are at `apps/cli/release-notes/next.md`\n" +
  "and on the GitHub Releases page.\n";

const fix = process.argv.includes("--fix");
const missing: string[] = [];

for (const pkgDir of findWorkspacePackages()) {
  const changelogPath = resolve(pkgDir, "CHANGELOG.md");
  if (existsSync(changelogPath)) continue;

  const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8")) as Pkg;
  const name = pkg.name ?? relative(repoRoot, pkgDir);

  if (fix) {
    writeFileSync(changelogPath, STUB_TEMPLATE(name));
    console.log(`Created stub: ${relative(repoRoot, changelogPath)}`);
  } else {
    missing.push(`${relative(repoRoot, pkgDir)} (${name})`);
  }
}

if (!fix && missing.length > 0) {
  console.error(
    `\nMissing CHANGELOG.md in ${missing.length} workspace package(s):\n  - ${missing.join("\n  - ")}\n\n` +
      "These are required by `changesets/action@v1` (the GitHub Action wrapping\n" +
      "Changesets in release.yml). Without them, release.yml crashes with ENOENT\n" +
      "and the Version Packages PR can't open.\n\n" +
      "Run `bun run scripts/check-changelog-stubs.ts --fix` to create stubs.\n",
  );
  process.exit(1);
}

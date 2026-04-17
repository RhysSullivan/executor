#!/usr/bin/env bun
/**
 * Publishes the public @executor-js/* workspace packages to npm.
 *
 * Walks a hard-coded list of publishable package directories, determines the
 * dist-tag from the version string (anything containing `-` is treated as beta),
 * and packs + publishes each package whose current version is not already on npm.
 *
 * Invoked from `.github/workflows/release.yml` via the `publish:` input on
 * changesets/action after the Version Packages PR has been merged, and locally
 * via `bun run release:publish:packages` (or `--dry-run`).
 */
import { $ } from "bun";
import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Channel = "latest" | "beta";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The repo uses `@executor/*` internally (matching historical package names
 * and the workspace graph) but publishes under `@executor-js/*` because the
 * short scope was taken on npm. At pack time we rewrite package manifests and
 * compiled `dist/` artifacts so the tarball ships with the public scope —
 * source code stays unchanged. Only package names in `PUBLIC_PACKAGE_DIRS`
 * are rewritten; unpublished peer deps like `@executor/api` / `@executor/react`
 * are left alone (they're optional peers and users who don't install them
 * just see a warning).
 */
const INTERNAL_SCOPE = "@executor";
const PUBLISHED_SCOPE = "@executor-js";

/**
 * Workspace-relative paths of the public packages. Kept explicit so a new
 * directory under `packages/plugins/` does not accidentally ship to npm.
 */
const PUBLIC_PACKAGE_DIRS = [
  "packages/core/storage-core",
  "packages/kernel/core",
  "packages/kernel/runtime-quickjs",
  "packages/core/sdk",
  "packages/core/execution",
  "packages/core/cli",
  "packages/plugins/file-secrets",
  "packages/plugins/google-discovery",
  "packages/plugins/graphql",
  "packages/plugins/keychain",
  "packages/plugins/mcp",
  "packages/plugins/onepassword",
  "packages/plugins/openapi",
] as const;

const parseArgs = (argv: ReadonlyArray<string>): { dryRun: boolean } => {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { dryRun };
};

const resolveChannel = (version: string): Channel => (version.includes("-") ? "beta" : "latest");

const readPackageMeta = async (pkgDir: string) => {
  const pkgJsonPath = join(pkgDir, "package.json");
  const pkg = (await Bun.file(pkgJsonPath).json()) as {
    name?: string;
    version?: string;
    private?: boolean;
  };

  if (!pkg.name || !pkg.version) {
    throw new Error(`Missing name/version in ${pkgJsonPath}`);
  }
  if (pkg.private === true) {
    throw new Error(`${pkg.name} is marked private and cannot be published`);
  }

  return { name: pkg.name, version: pkg.version };
};

const packageAlreadyPublished = async (name: string, version: string): Promise<boolean> => {
  const proc = Bun.spawn(["npm", "view", `${name}@${version}`, "version"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return (await proc.exited) === 0;
};

type DependencyBlock = Record<string, string>;
type MutablePackageJson = {
  name?: string;
  dependencies?: DependencyBlock;
  devDependencies?: DependencyBlock;
  peerDependencies?: DependencyBlock;
  optionalDependencies?: DependencyBlock;
  [key: string]: unknown;
};

/**
 * Rewrites the internal `@executor/*` scope to the published `@executor-js/*`
 * scope for the given set of names, inside both `package.json` (name +
 * dep blocks) and compiled `dist/` artifacts (`.js`, `.d.ts`). Also resolves
 * `workspace:*` dep references to concrete versions, since `bun pm pack`
 * can't resolve workspace specifiers that no longer match any workspace name
 * (after the rename). Returns a restore function that reverts every file we
 * touched. Only names in `publishable` are rewritten — `@executor/api` and
 * `@executor/react` are left alone because they're unpublished optional peers.
 */
const applyScopeRename = async (
  pkgDir: string,
  publishable: ReadonlySet<string>,
  publishableVersions: ReadonlyMap<string, string>,
): Promise<() => Promise<void>> => {
  const toPublished = (internal: string): string =>
    internal.replace(`${INTERNAL_SCOPE}/`, `${PUBLISHED_SCOPE}/`);
  const toInternal = (published: string): string =>
    published.replace(`${PUBLISHED_SCOPE}/`, `${INTERNAL_SCOPE}/`);

  const publishableInternalNames = new Set<string>();
  for (const published of publishable) publishableInternalNames.add(toInternal(published));

  const renameDepBlock = (block: DependencyBlock | undefined): DependencyBlock | undefined => {
    if (!block) return block;
    const next: DependencyBlock = {};
    let mutated = false;
    for (const [key, value] of Object.entries(block)) {
      if (publishableInternalNames.has(key)) {
        const newKey = toPublished(key);
        // Resolve workspace:* to the concrete version of the published package.
        const newValue = value.startsWith("workspace:")
          ? (publishableVersions.get(newKey) ?? value)
          : value;
        next[newKey] = newValue;
        mutated = true;
      } else {
        next[key] = value;
      }
    }
    return mutated ? next : block;
  };

  const snapshots = new Map<string, string>();
  const writeIfChanged = async (absPath: string, next: string): Promise<void> => {
    const original = await readFile(absPath, "utf8");
    if (next === original) return;
    snapshots.set(absPath, original);
    await writeFile(absPath, next);
  };

  // 1. package.json — rewrite `name` and every dep block structurally so we
  //    can also resolve workspace specifiers while we're here.
  const pkgJsonPath = join(pkgDir, "package.json");
  const pkgRaw = await readFile(pkgJsonPath, "utf8");
  const pkg = JSON.parse(pkgRaw) as MutablePackageJson;
  if (pkg.name && publishableInternalNames.has(pkg.name)) {
    pkg.name = toPublished(pkg.name);
  }
  pkg.dependencies = renameDepBlock(pkg.dependencies);
  pkg.devDependencies = renameDepBlock(pkg.devDependencies);
  pkg.peerDependencies = renameDepBlock(pkg.peerDependencies);
  pkg.optionalDependencies = renameDepBlock(pkg.optionalDependencies);
  const pkgNext = `${JSON.stringify(pkg, null, 2)}\n`;
  if (pkgNext !== pkgRaw) {
    snapshots.set(pkgJsonPath, pkgRaw);
    await writeFile(pkgJsonPath, pkgNext);
  }

  // 2. dist/**/*.{js,d.ts} — plain string replace of import specifiers, one
  //    package name at a time. Longest-first avoids partial matches.
  const orderedInternal = [...publishableInternalNames].sort((a, b) => b.length - a.length);
  const replaceAllInText = (text: string): string => {
    let out = text;
    for (const internal of orderedInternal) {
      out = out.split(internal).join(toPublished(internal));
    }
    return out;
  };
  const distDir = join(pkgDir, "dist");
  if (existsSync(distDir)) {
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir);
      for (const entry of entries) {
        const abs = join(dir, entry);
        const info = await stat(abs);
        if (info.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (entry.endsWith(".js") || entry.endsWith(".d.ts")) {
          const original = await readFile(abs, "utf8");
          await writeIfChanged(abs, replaceAllInText(original));
        }
      }
    };
    await walk(distDir);
  }

  return async () => {
    for (const [path, original] of snapshots) {
      await writeFile(path, original);
    }
  };
};

/**
 * Applies `publishConfig` field overrides to package.json in place, returning a
 * function that restores the original file. `bun pm pack` does not substitute
 * `publishConfig.exports` / `publishConfig.main` etc at pack time (npm does,
 * but only for a subset of fields and only for `npm pack`), so we rewrite the
 * file ourselves so the packed tarball has the correct `exports` pointing at
 * `dist/` instead of the dev-time `src/index.ts`.
 */
const applyPublishConfig = async (pkgDir: string): Promise<() => Promise<void>> => {
  const pkgJsonPath = join(pkgDir, "package.json");
  const original = await readFile(pkgJsonPath, "utf8");
  const parsed = JSON.parse(original) as {
    publishConfig?: Record<string, unknown>;
    [key: string]: unknown;
  };

  const publishConfig = parsed.publishConfig;
  if (!publishConfig || typeof publishConfig !== "object") {
    return async () => {};
  }

  // Fields we allow publishConfig to override. `access`/`tag`/`registry` are
  // real npm publish-time config keys — they must NOT be hoisted into the
  // top-level manifest.
  const overridable = new Set([
    "exports",
    "main",
    "module",
    "types",
    "typings",
    "bin",
    "browser",
    "files",
  ]);

  const nextPublishConfig: Record<string, unknown> = {};
  let mutated = false;
  for (const [key, value] of Object.entries(publishConfig)) {
    if (overridable.has(key)) {
      parsed[key] = value;
      mutated = true;
    } else {
      nextPublishConfig[key] = value;
    }
  }

  if (!mutated) {
    return async () => {};
  }

  if (Object.keys(nextPublishConfig).length === 0) {
    delete parsed.publishConfig;
  } else {
    parsed.publishConfig = nextPublishConfig;
  }

  await writeFile(pkgJsonPath, `${JSON.stringify(parsed, null, 2)}\n`);
  return async () => {
    await writeFile(pkgJsonPath, original);
  };
};

const publishPackage = async (
  pkgDir: string,
  dryRun: boolean,
  publishable: ReadonlySet<string>,
  publishableVersions: ReadonlyMap<string, string>,
) => {
  const { name: internalName, version } = await readPackageMeta(pkgDir);
  const publishedName = internalName.replace(`${INTERNAL_SCOPE}/`, `${PUBLISHED_SCOPE}/`);
  const channel = resolveChannel(version);

  if (!existsSync(join(pkgDir, "dist"))) {
    throw new Error(`Missing dist/ in ${pkgDir}. Did you run 'bun run build:packages'?`);
  }

  if (await packageAlreadyPublished(publishedName, version)) {
    console.log(`[skip] ${publishedName}@${version} already on npm`);
    return;
  }

  console.log(`[publish] ${publishedName}@${version} (${channel})${dryRun ? " [dry-run]" : ""}`);

  // Clean any stale tarballs from previous runs so our readdir finds exactly
  // the archive produced by the pack below.
  const stale = (await readdir(pkgDir)).filter((entry) => entry.endsWith(".tgz"));
  for (const entry of stale) {
    await rm(join(pkgDir, entry), { force: true });
  }

  // Order matters: rename the scope first so publishConfig sees the final
  // package.json, then apply publishConfig on top. Restore in reverse.
  const restoreScope = await applyScopeRename(pkgDir, publishable, publishableVersions);
  const restorePublishConfig = await applyPublishConfig(pkgDir);
  try {
    await $`bun pm pack`.cwd(pkgDir);
  } finally {
    await restorePublishConfig();
    await restoreScope();
  }

  const produced = (await readdir(pkgDir)).filter((entry) => entry.endsWith(".tgz"));
  if (produced.length !== 1) {
    throw new Error(
      `Expected exactly 1 .tgz in ${pkgDir}, found ${produced.length}: ${produced.join(", ")}`,
    );
  }
  const tarball = produced[0]!;

  if (dryRun) {
    return;
  }

  const args = ["publish", tarball, "--access", "public", "--tag", channel];
  if (process.env.GITHUB_ACTIONS === "true") {
    args.push("--provenance");
  }
  await $`npm ${args}`.cwd(pkgDir);
};

const main = async () => {
  const { dryRun } = parseArgs(process.argv.slice(2));

  // Each package's own version determines its dist-tag (pre-release versions
  // with `-` publish to `beta`, everything else to `latest`). Packages are
  // only skipped when their current version is already on npm.
  console.log(`Publishing ${PUBLISHED_SCOPE} packages${dryRun ? " [dry-run]" : ""}`);

  await $`bun run build:packages`.cwd(repoRoot);

  // Snapshot the internal package names and versions up front so
  // applyScopeRename knows (a) which `@executor/*` references to rewrite
  // (vs. unpublished peer deps like `@executor/api` that should be left
  // alone) and (b) how to resolve `workspace:*` dep specifiers after the
  // rename — `bun pm pack` can no longer resolve them itself once the name
  // doesn't match any workspace.
  const publishable = new Set<string>();
  const publishableVersions = new Map<string, string>();
  for (const relDir of PUBLIC_PACKAGE_DIRS) {
    const pkg = await readPackageMeta(join(repoRoot, relDir));
    const publishedName = pkg.name.replace(`${INTERNAL_SCOPE}/`, `${PUBLISHED_SCOPE}/`);
    publishable.add(publishedName);
    publishableVersions.set(publishedName, pkg.version);
  }

  for (const relDir of PUBLIC_PACKAGE_DIRS) {
    await publishPackage(join(repoRoot, relDir), dryRun, publishable, publishableVersions);
  }
};

await main();

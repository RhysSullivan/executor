import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

const root = process.cwd();
const out = join(root, ".selfhost-runtime");
const appName = "@executor-js/host-selfhost";

const packageRoots = ["apps", "packages", "examples"] as const;
const packagePruneExtensions = [".map", ".d.ts", ".d.mts", ".d.cts", ".md", ".markdown"];
const nodeModulePruneExtensions = [...packagePruneExtensions, ".ts", ".tsx"];
const sourcePruneExtensions = [".test.ts", ".test.tsx"];
const prunedDirNames = new Set([
  ".git",
  ".turbo",
  "test",
  "tests",
  "__tests__",
  "fixtures",
  "fixture",
  "examples",
  "__snapshots__",
]);
const packageConfigFiles = new Set([
  "tsconfig.json",
  "tsup.config.ts",
  "vite.config.ts",
  "vitest.config.ts",
  "CHANGELOG.md",
]);

const nodeModulesPackagePrunes = [
  /^@ant-design\+/,
  /^@base-ui\+/,
  /^@cloudflare\+workers-types@/,
  /^@electric-sql\+pglite@/,
  /^@emotion\+react@/,
  /^@emoji-mart\+/,
  /^@esbuild\+.*linux-x64-musl/,
  /^@esbuild\+/,
  /^@floating-ui\+react@/,
  /^@dnd-kit\+/,
  /^@hookform\+/,
  /^@lobehub\+/,
  /^@mermaid-js\+/,
  /^@pierre\+diffs@/,
  /^@pierre\+theme@/,
  /^@primer\+octicons@/,
  /^@rc-component\+/,
  /^@rolldown\+binding-/,
  /^@reduxjs\+/,
  /^@shikijs\+/,
  /^@splinetool\+/,
  /^@tanstack\+start-plugin-core@/,
  /^@tanstack\+react-router@/,
  /^@tanstack\+router-core@/,
  /^@types\+/,
  /^ahooks@/,
  /^antd@/,
  /^better-sqlite3@/,
  /^bun-types@/,
  /^caniuse-lite@/,
  /^chroma-js@/,
  /^cytoscape/,
  /^d3@/,
  /^date-fns/,
  /^drizzle-kit@/,
  /^dompurify@/,
  /^emoji-mart@/,
  /^framer-motion@/,
  /^jiti@/,
  /^katex@/,
  /^layout-base@/,
  /^leva@/,
  /^lightningcss-/,
  /^lit-html@/,
  /^lucide-react@/,
  /^mermaid@/,
  /^motion@/,
  /^motion-/,
  /^polished@/,
  /^prettier@/,
  /^react-day-picker@/,
  /^react-hook-form@/,
  /^react@/,
  /^react-dom@/,
  /^react-dropzone@/,
  /^recharts@/,
  /^rolldown@/,
  /^shiki@/,
  /^solid-js@/,
  /^source-map@/,
  /^tailwind-merge@/,
  /^tsx@/,
  /^@upsetjs\+venn\.js@/,
  /^victory-vendor@/,
  /^virtua@/,
  /^typeorm@/,
  /^vite@/,
  /^vitest@/,
];

type PackageJson = {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
};

type WorkspacePackage = {
  readonly name: string;
  readonly dir: string;
  readonly packageJson: PackageJson;
};

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const copyRecursive = (
  source: string,
  target: string,
  shouldSkip: (
    source: string,
    relativePath: string,
    stats: ReturnType<typeof lstatSync>,
  ) => boolean,
) => {
  const stats = lstatSync(source);
  const rel = relative(root, source);
  if (shouldSkip(source, rel, stats)) return;

  if (stats.isSymbolicLink()) {
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(readlinkSync(source), target);
    return;
  }

  if (stats.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyRecursive(join(source, entry), join(target, entry), shouldSkip);
    }
    return;
  }

  if (stats.isFile()) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
};

const discoverWorkspacePackages = (): Map<string, WorkspacePackage> => {
  const packages = new Map<string, WorkspacePackage>();
  for (const rootName of packageRoots) {
    const rootDir = join(root, rootName);
    if (!existsSync(rootDir)) continue;
    for (const first of readdirSync(rootDir)) {
      const firstDir = join(rootDir, first);
      if (!lstatSync(firstDir).isDirectory()) continue;
      const candidates = [firstDir, ...readdirSync(firstDir).map((name) => join(firstDir, name))];
      for (const candidate of candidates) {
        const packageJsonPath = join(candidate, "package.json");
        if (!existsSync(packageJsonPath)) continue;
        const packageJson = readJson<PackageJson>(packageJsonPath);
        if (packageJson.name) {
          packages.set(packageJson.name, { name: packageJson.name, dir: candidate, packageJson });
        }
      }
    }
  }
  return packages;
};

const workspacePackages = discoverWorkspacePackages();
const target = workspacePackages.get(appName);
if (!target) throw new Error(`Could not find ${appName}`);

const reachable = new Map<string, WorkspacePackage>();
const queue = [target];
for (const current of queue) {
  if (reachable.has(current.name)) continue;
  reachable.set(current.name, current);
  const dependencies = {
    ...current.packageJson.dependencies,
    ...current.packageJson.optionalDependencies,
  };
  for (const dependencyName of Object.keys(dependencies)) {
    const workspaceDependency = workspacePackages.get(dependencyName);
    if (workspaceDependency) queue.push(workspaceDependency);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

copyRecursive(join(root, "package.json"), join(out, "package.json"), () => false);
copyRecursive(join(root, "bun.lock"), join(out, "bun.lock"), () => false);

copyRecursive(join(root, "node_modules"), join(out, "node_modules"), (source, rel, stats) => {
  const base = source.split("/node_modules/.bun/")[1]?.split("/")[0];
  if (base?.includes("linux-x64-musl")) return true;
  if (base && nodeModulesPackagePrunes.some((pattern) => pattern.test(base))) return true;
  const name = source.split("/").at(-1) ?? "";
  if (stats.isDirectory() && source !== join(root, "node_modules") && prunedDirNames.has(name))
    return true;
  if (stats.isFile() && nodeModulePruneExtensions.some((extension) => source.endsWith(extension)))
    return true;
  return false;
});

for (const pkg of reachable.values()) {
  const destination = join(out, relative(root, pkg.dir));
  copyRecursive(pkg.dir, destination, (source, rel, stats) => {
    const name = source.split("/").at(-1) ?? "";
    if (stats.isDirectory() && prunedDirNames.has(name)) return true;
    if (stats.isFile() && packageConfigFiles.has(name)) return true;
    if (stats.isFile() && sourcePruneExtensions.some((extension) => source.endsWith(extension)))
      return true;
    if (stats.isFile() && packagePruneExtensions.some((extension) => source.endsWith(extension)))
      return true;
    if (rel === "apps/host-selfhost/Dockerfile" || rel === "apps/host-selfhost/docker-compose.yml")
      return true;
    if (rel.startsWith("apps/host-selfhost/web/")) return true;
    if (rel.startsWith("apps/host-selfhost/scripts/")) return true;
    return false;
  });
}

console.log(`Packaged ${reachable.size} workspace packages into ${relative(root, out)}`);

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readDistributionPackageMetadata, repoRoot } from "./metadata";

const defaultOutputDir = resolve(repoRoot, "apps/executor/dist/npm");
const DENO_INSTALL_URL = "https://docs.deno.com/runtime/getting_started/installation/";


export type BuildDistributionPackageOptions = {
  outputDir?: string;
  packageName?: string;
  packageVersion?: string;
  buildWeb?: boolean;
};

export type DistributionPackageArtifact = {
  packageDir: string;
  launcherPath: string;
  bundlePath: string;
  resourcesDir: string;
};

type CommandInput = {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
};

const runCommand = async (input: CommandInput): Promise<void> => {
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolveExitCode, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolveExitCode(code ?? -1);
    });
  });

  if (exitCode === 0) {
    return;
  }

  throw new Error(
    [
      `${input.command} ${input.args.join(" ")} exited with code ${exitCode}`,
      stdout.trim().length > 0 ? `stdout:\n${stdout.trim()}` : null,
      stderr.trim().length > 0 ? `stderr:\n${stderr.trim()}` : null,
    ]
      .filter((part) => part !== null)
      .join("\n\n"),
  );
};

const resolvePGliteDistDir = (): string => {
  const bunDir = join(repoRoot, "node_modules/.bun");
  const packageDir = readdirSync(bunDir).find((entry) =>
    entry.startsWith("@electric-sql+pglite@"),
  );

  if (!packageDir) {
    throw new Error(`Unable to locate PGlite package under ${bunDir}`);
  }

  const distDir = join(
    bunDir,
    packageDir,
    "node_modules/@electric-sql/pglite/dist",
  );

  if (!existsSync(distDir)) {
    throw new Error(`Unable to locate PGlite dist directory at ${distDir}`);
  }

  return distDir;
};


const createPackageJson = (input: {
  packageName: string;
  packageVersion: string;
  description: string;
  keywords: ReadonlyArray<string>;
  homepage?: string;
  bugs?: {
    url?: string;
  };
  repository?: {
    type?: string;
    url?: string;
  };
  license?: string;
}) => {
  const packageJson = {
    name: input.packageName,
    version: input.packageVersion,
    description: input.description,
    keywords: input.keywords,
    homepage: input.homepage,
    bugs: input.bugs,
    repository: input.repository,
    license: input.license ?? "MIT",
    type: "module",
    private: false,
    bin: {
      executor: "bin/executor.js",
    },
    scripts: {
      postinstall: "node ./bin/postinstall.js",
    },
    files: [
      "bin",
      "resources",
      "README.md",
      "package.json",
    ],
    engines: {
      node: ">=20",
    },
  };

  return JSON.stringify(packageJson, null, 2) + "\n";
};

const createLauncherSource = () => [
  "#!/usr/bin/env node",
  'import "./executor.mjs";',
  "",
].join("\n");

const createPostinstallSource = () => [
  "#!/usr/bin/env node",
  'import { spawnSync } from "node:child_process";',
  'import { existsSync } from "node:fs";',
  'import { join } from "node:path";',
  "",
  `const denoInstallUrl = ${JSON.stringify(DENO_INSTALL_URL)};`,
  "",
  "const resolveDenoExecutable = () => {",
  '  const configured = process.env.DENO_BIN?.trim();',
  '  if (configured) {',
  '    return configured;',
  '  }',
  "",
  '  const home = process.env.HOME?.trim();',
  '  if (home) {',
  '    const installedPath = join(home, ".deno", "bin", "deno");',
  '    if (existsSync(installedPath)) {',
  '      return installedPath;',
  '    }',
  '  }',
  "",
  '  return "deno";',
  "};",
  "",
  "const isDenoAvailable = (executable) => {",
  '  const result = spawnSync(executable, ["--version"], {',
  '    stdio: "ignore",',
  '    timeout: 5000,',
  '  });',
  "",
  '  return result.error === undefined && result.status === 0;',
  "};",
  "",
  "const denoExecutable = resolveDenoExecutable();",
  "",
  "if (!isDenoAvailable(denoExecutable)) {",
  '  console.warn(`Deno not found, if you want to use deno for sandboxing install it from ${denoInstallUrl} otherwise JS will execute in SES`);',
  "}",
  "",
].join("\n");

export const buildDistributionPackage = async (
  options: BuildDistributionPackageOptions = {},
): Promise<DistributionPackageArtifact> => {
  const defaults = await readDistributionPackageMetadata();
  const packageDir = resolve(options.outputDir ?? defaultOutputDir);
  const binDir = join(packageDir, "bin");
  const resourcesDir = join(packageDir, "resources");
  const webDir = join(resourcesDir, "web");
  const migrationsDir = join(resourcesDir, "migrations");
  const bundlePath = join(binDir, "executor.mjs");
  const launcherPath = join(binDir, "executor.js");
  const postinstallPath = join(binDir, "postinstall.js");
  const pgliteDistDir = resolvePGliteDistDir();
  const pgliteDataPath = join(pgliteDistDir, "pglite.data");
  const pgliteWasmPath = join(pgliteDistDir, "pglite.wasm");
  const webDistDir = join(repoRoot, "apps/web/dist");
  const readmePath = join(repoRoot, "README.md");
  const packageName = options.packageName ?? defaults.name;
  const packageVersion = options.packageVersion ?? defaults.version;
  await rm(packageDir, { recursive: true, force: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(resourcesDir, { recursive: true });

  if (options.buildWeb ?? true) {
    await runCommand({
      command: "bun",
      args: ["run", "build"],
      cwd: join(repoRoot, "apps/web"),
    });
  }

  if (!existsSync(webDistDir)) {
    throw new Error(`Missing built web assets at ${webDistDir}`);
  }

  await runCommand({
    command: "bun",
    args: [
      "build",
      "./apps/executor/src/cli/main.ts",
      "--target",
      "node",
      "--outfile",
      bundlePath,
    ],
    cwd: repoRoot,
  });

  await cp(webDistDir, webDir, { recursive: true });
  await cp(join(repoRoot, "packages/control-plane/drizzle"), migrationsDir, {
    recursive: true,
  });
  await cp(pgliteDataPath, join(binDir, "pglite.data"));
  await cp(pgliteWasmPath, join(binDir, "pglite.wasm"));
  await mkdir(join(binDir, "openapi-extractor-wasm"), { recursive: true });
  await cp(
    join(repoRoot, "packages/codemode-openapi/src/openapi-extractor-wasm/openapi_extractor_bg.wasm"),
    join(binDir, "openapi-extractor-wasm/openapi_extractor_bg.wasm"),
  );
  await cp(
    join(repoRoot, "packages/runtime-deno-subprocess/src/deno-subprocess-worker.mjs"),
    join(binDir, "deno-subprocess-worker.mjs"),
  );
  await writeFile(join(packageDir, "package.json"), createPackageJson({
    packageName,
    packageVersion,
    description: defaults.description,
    keywords: defaults.keywords,
    homepage: defaults.homepage,
    bugs: defaults.bugs,
    repository: defaults.repository,
    license: defaults.license,
  }));
  await cp(readmePath, join(packageDir, "README.md"));
  await writeFile(launcherPath, createLauncherSource());
  await writeFile(postinstallPath, createPostinstallSource());
  await chmod(launcherPath, 0o755);
  await chmod(postinstallPath, 0o755);

  return {
    packageDir,
    launcherPath,
    bundlePath,
    resourcesDir,
  };
};

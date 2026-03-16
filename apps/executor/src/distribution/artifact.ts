import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { readDistributionPackageMetadata, repoRoot } from "./metadata";

const defaultOutputDir = resolve(repoRoot, "apps/executor/dist/npm");


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

const resolveQuickJsWasmPath = (): string => {
  const requireFromQuickJsRuntime = createRequire(
    join(repoRoot, "packages/runtime-quickjs/package.json"),
  );
  const quickJsPackagePath = requireFromQuickJsRuntime.resolve(
    "quickjs-emscripten/package.json",
  );
  const wasmPath = resolve(
    dirname(quickJsPackagePath),
    "../@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm",
  );

  if (!existsSync(wasmPath)) {
    throw new Error(`Unable to locate QuickJS wasm asset at ${wasmPath}`);
  }

  return wasmPath;
};

const resolveJsoncParserUmdImplPath = async (): Promise<string> => {
  const requireFromControlPlane = createRequire(
    join(repoRoot, "packages/control-plane/package.json"),
  );
  const jsoncParserPackagePath = requireFromControlPlane.resolve(
    "jsonc-parser/package.json",
  );
  const jsoncParserUmdImplPath = resolve(dirname(jsoncParserPackagePath), "lib/umd/impl");

  if (!existsSync(jsoncParserUmdImplPath)) {
    throw new Error(
      `Unable to locate jsonc-parser UMD implementation files at ${jsoncParserUmdImplPath}`,
    );
  }

  return jsoncParserUmdImplPath;
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

export const buildDistributionPackage = async (
  options: BuildDistributionPackageOptions = {},
): Promise<DistributionPackageArtifact> => {
  const defaults = await readDistributionPackageMetadata();
  const packageDir = resolve(options.outputDir ?? defaultOutputDir);
  const binDir = join(packageDir, "bin");
  const resourcesDir = join(packageDir, "resources");
  const webDir = join(resourcesDir, "web");
  const bundlePath = join(binDir, "executor.mjs");
  const launcherPath = join(binDir, "executor.js");
  const quickJsWasmPath = resolveQuickJsWasmPath();
  const jsoncParserUmdImplPath = await resolveJsoncParserUmdImplPath();
  const webDistDir = join(repoRoot, "apps/web/dist");
  const readmePath = join(repoRoot, "README.md");
  const packageName = options.packageName ?? defaults.name;
  const packageVersion = options.packageVersion ?? defaults.version;
  await rm(packageDir, { recursive: true, force: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(resourcesDir, { recursive: true });

  if ((options.buildWeb ?? true) || !existsSync(webDistDir)) {
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
  await cp(quickJsWasmPath, join(binDir, "emscripten-module.wasm"));
  await cp(jsoncParserUmdImplPath, join(binDir, "impl"), { recursive: true });
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
  await chmod(launcherPath, 0o755);

  return {
    packageDir,
    launcherPath,
    bundlePath,
    resourcesDir,
  };
};

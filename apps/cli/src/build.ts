import { cp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliRoot = resolve(repoRoot, "apps/cli");
const webRoot = resolve(repoRoot, "apps/local");
const distDir = resolve(cliRoot, "dist");

const resolveQuickJsWasmPath = (): string => {
  const req = createRequire(join(repoRoot, "packages/kernel/runtime-quickjs/package.json"));
  const quickJsPkg = req.resolve("quickjs-emscripten/package.json");
  const wasmPath = resolve(
    dirname(quickJsPkg),
    "../@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm",
  );
  if (!existsSync(wasmPath)) throw new Error(`QuickJS WASM not found at ${wasmPath}`);
  return wasmPath;
};

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const readMetadata = async () => {
  const rootPkg = await Bun.file(join(repoRoot, "package.json")).json();
  const cliPkg = await Bun.file(join(cliRoot, "package.json")).json();
  return {
    name: "executor",
    version: process.env.EXECUTOR_VERSION ?? cliPkg.version ?? rootPkg.version ?? "0.0.0",
    description: rootPkg.description ?? "Local AI executor with a CLI, local API server, and web UI.",
    keywords: rootPkg.keywords ?? [],
    homepage: rootPkg.homepage,
    bugs: rootPkg.bugs,
    repository: rootPkg.repository,
    license: rootPkg.license ?? "MIT",
  };
};

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

type Target = {
  os: "linux" | "darwin" | "win32";
  arch: "x64" | "arm64";
  abi?: "musl";
};

const ALL_TARGETS: Target[] = [
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "arm64" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "arm64" },
];

const platformName = (t: Target) =>
  t.os === "win32" ? "windows" : t.os;

const targetPackageName = (t: Target) =>
  ["executor", platformName(t), t.arch, t.abi].filter(Boolean).join("-");

const bunTarget = (t: Target) =>
  ["bun", platformName(t), t.arch, t.abi].filter(Boolean).join("-");

const binaryName = (t: Target) =>
  t.os === "win32" ? "executor.exe" : "executor";

const isCurrentPlatform = (t: Target) =>
  t.os === process.platform && t.arch === process.arch && !t.abi;

// ---------------------------------------------------------------------------
// Build web app
// ---------------------------------------------------------------------------

const buildWeb = async () => {
  const webDist = join(webRoot, "dist");
  await rm(webDist, { recursive: true, force: true });

  console.log("Building web app...");
  const proc = Bun.spawn(["bun", "run", "build"], {
    cwd: webRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, NODE_ENV: "production" },
  });
  if ((await proc.exited) !== 0) throw new Error("Web build failed");
  return webDist;
};

// ---------------------------------------------------------------------------
// Embedded web UI — generates a virtual module that imports all web assets
// using `with { type: "file" }` so Bun bakes them into the compiled binary.
// ---------------------------------------------------------------------------

const createEmbeddedWebUISource = async () => {
  const webDist = await buildWeb();
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: webDist })))
    .map((f) => f.replaceAll("\\", "/"))
    .sort();

  const imports = files.map((file, i) => {
    const spec = join(webDist, file).replaceAll("\\", "/");
    return `import file_${i} from ${JSON.stringify(spec)} with { type: "file" };`;
  });

  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`);

  return [
    "// Auto-generated — maps web UI paths to embedded file references",
    ...imports,
    "export default {",
    ...entries,
    "} as Record<string, string>;",
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Build platform binaries
// ---------------------------------------------------------------------------

const EMBEDDED_WEB_UI_STUB = `const files: Record<string, string> | null = null;\n\nexport default files;\n`;

const buildBinaries = async (targets: Target[]) => {
  const meta = await readMetadata();
  const binaries: Record<string, string> = {};
  const embeddedWebUIPath = join(cliRoot, "src/embedded-web-ui.gen.ts");

  await rm(distDir, { recursive: true, force: true });

  console.log("Generating embedded web UI bundle...");
  const embeddedWebUI = await createEmbeddedWebUISource();
  await writeFile(embeddedWebUIPath, `${embeddedWebUI}\n`);
  const quickJsWasmPath = resolveQuickJsWasmPath();

  try {
    for (const target of targets) {
    const name = targetPackageName(target);
    const outDir = join(distDir, name);
    const binDir = join(outDir, "bin");
    await mkdir(binDir, { recursive: true });

    console.log(`Building ${name}...`);

    await Bun.build({
      entrypoints: [join(cliRoot, "src/main.ts")],
      minify: true,
      compile: {
        target: bunTarget(target) as any,
        outfile: join(binDir, binaryName(target)),
      },
    });

    // Copy QuickJS WASM next to binary — loaded at runtime by the server
    await cp(quickJsWasmPath, join(binDir, "emscripten-module.wasm"));

    // Smoke test on current platform
    if (isCurrentPlatform(target)) {
      const bin = join(binDir, binaryName(target));
      console.log(`  Smoke test: ${bin} --version`);
      const version = await $`${bin} --version`.text();
      console.log(`  OK: ${version.trim()}`);
    }

    // Platform package.json
    await writeFile(
      join(outDir, "package.json"),
      JSON.stringify(
        {
          name,
          version: meta.version,
          os: [target.os],
          cpu: [target.arch],
          bin: { executor: `bin/${binaryName(target)}` },
        },
        null,
        2,
      ) + "\n",
    );

    binaries[name] = meta.version;
  }

    return binaries;
  } finally {
    await writeFile(embeddedWebUIPath, EMBEDDED_WEB_UI_STUB);
  }
};

// ---------------------------------------------------------------------------
// Build wrapper npm package
// ---------------------------------------------------------------------------

const buildWrapperPackage = async (binaries: Record<string, string>) => {
  const meta = await readMetadata();
  const wrapperDir = join(distDir, meta.name);
  const binDir = join(wrapperDir, "bin");

  await mkdir(binDir, { recursive: true });

  // Node.js shim that spawns the downloaded platform binary
  await writeFile(join(binDir, "executor"), NODE_SHIM);
  await chmod(join(binDir, "executor"), 0o755);

  // Postinstall downloads the matching release asset from GitHub Releases
  await writeFile(join(wrapperDir, "postinstall.cjs"), POSTINSTALL_SCRIPT);

  // Package.json
  await writeFile(
    join(wrapperDir, "package.json"),
    JSON.stringify(
      {
        name: meta.name,
        version: meta.version,
        description: meta.description,
        keywords: meta.keywords,
        homepage: meta.homepage,
        bugs: meta.bugs,
        repository: meta.repository,
        license: meta.license,
        bin: { executor: "bin/executor" },
        scripts: {
          postinstall: "node ./postinstall.cjs",
        },
        engines: {
          node: ">=20",
        },
      },
      null,
      2,
    ) + "\n",
  );

  // README
  const readmePath = join(repoRoot, "README.md");
  if (existsSync(readmePath)) {
    await cp(readmePath, join(wrapperDir, "README.md"));
  }

  console.log(`\nWrapper package: ${wrapperDir}`);
  console.log(`  ${meta.name}@${meta.version}`);
  console.log(`  release assets: ${Object.keys(binaries).join(", ")}`);
};

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

const packageAlreadyPublished = async (pkgDir: string) => {
  const pkg = await Bun.file(join(pkgDir, "package.json")).json() as {
    name?: string;
    version?: string;
  };

  if (!pkg.name || !pkg.version) {
    throw new Error(`Missing name/version in ${join(pkgDir, "package.json")}`);
  }

  const proc = Bun.spawn(["npm", "view", `${pkg.name}@${pkg.version}`, "version"], {
    cwd: pkgDir,
    stdio: ["ignore", "ignore", "ignore"],
  });

  return (await proc.exited) === 0;
};

const publishPackedPackage = async (pkgDir: string, channel: string) => {
  if (await packageAlreadyPublished(pkgDir)) {
    console.log(`Skipping ${pkgDir}; package version already exists on npm.`);
    return;
  }

  await $`bun pm pack`.cwd(pkgDir);

  if (process.env.GITHUB_ACTIONS === "true") {
    await $`npm publish *.tgz --access public --tag ${channel} --provenance`.cwd(pkgDir);
  } else {
    await $`npm publish *.tgz --access public --tag ${channel}`.cwd(pkgDir);
  }
};

const publish = async (channel: string) => {
  const meta = await readMetadata();

  // Publish only the wrapper npm package. Platform binaries are distributed via GitHub release assets.
  const wrapperDir = join(distDir, meta.name);
  console.log(`Publishing ${wrapperDir}...`);
  await publishPackedPackage(wrapperDir, channel);
};

// ---------------------------------------------------------------------------
// GitHub release assets
// ---------------------------------------------------------------------------

const ZIP_ASSET_SCRIPT = [
  "import pathlib, sys, zipfile",
  "output = pathlib.Path(sys.argv[1])",
  "with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:",
  "    for path in pathlib.Path('.').rglob('*'):",
  "        if path.is_file():",
  "            archive.write(path, path.as_posix())",
].join("\n");

const createReleaseAssets = async () => {
  for (const entry of new Bun.Glob("executor-*/package.json").scanSync({ cwd: distDir })) {
    const pkgDir = join(distDir, dirname(entry));
    const pkg = await Bun.file(join(pkgDir, "package.json")).json();
    const name = pkg.name as string;

    if (name.includes("linux")) {
      await $`tar -czf ${join(distDir, `${name}.tar.gz`)} *`.cwd(join(pkgDir, "bin"));
    } else {
      await $`python3 -c ${ZIP_ASSET_SCRIPT} ${join(distDir, `${name}.zip`)}`.cwd(join(pkgDir, "bin"));
    }

    console.log(`Created release asset: ${name}`);
  }
};

// ---------------------------------------------------------------------------
// Node.js shim — finds the right platform binary and spawns it
// ---------------------------------------------------------------------------

const NODE_SHIM = `#!/usr/bin/env node
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

function run(target) {
  const result = childProcess.spawnSync(target, process.argv.slice(2), { stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(typeof result.status === "number" ? result.status : 0);
}

if (process.env.EXECUTOR_BIN_PATH) run(process.env.EXECUTOR_BIN_PATH);

const scriptDir = path.dirname(fs.realpathSync(__filename));
const binary = process.platform === "win32" ? "executor.exe" : "executor";
const runtimeBinary = path.join(scriptDir, "runtime", binary);
const legacyCached = path.join(scriptDir, process.platform === "win32" ? ".executor.exe" : ".executor");

const resolveInstalledBinary = () => {
  if (fs.existsSync(runtimeBinary)) {
    return runtimeBinary;
  }
  if (fs.existsSync(legacyCached)) {
    return legacyCached;
  }
  return null;
};

const installIfNeeded = () => {
  const existing = resolveInstalledBinary();
  if (existing) {
    return existing;
  }

  const installer = path.resolve(scriptDir, "..", "postinstall.cjs");
  if (!fs.existsSync(installer)) {
    return null;
  }

  console.error("executor binary is missing; downloading release asset...");
  const result = childProcess.spawnSync(process.execPath, [installer], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }

  return resolveInstalledBinary();
};

const installedBinary = installIfNeeded();
if (!installedBinary) {
  console.error("executor binary is missing. Reinstall the package or run 'npm rebuild executor'.");
  process.exit(1);
}

run(installedBinary);
`;

// ---------------------------------------------------------------------------
// Postinstall — hardlink/copy the platform binary for fast startup
// ---------------------------------------------------------------------------

const POSTINSTALL_SCRIPT = `#!/usr/bin/env node
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const packageDir = path.dirname(fs.realpathSync(__filename));
const binDir = path.join(packageDir, "bin");
const runtimeDir = path.join(binDir, "runtime");
const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));

const repositoryUrl = typeof packageJson.repository === "string"
  ? packageJson.repository
  : packageJson.repository && packageJson.repository.url;
const githubBase = String(packageJson.homepage || repositoryUrl || "https://github.com/RhysSullivan/executor")
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");
const version = packageJson.version;

const platformMap = { darwin: "darwin", linux: "linux", win32: "windows" };
const platform = platformMap[os.platform()] || os.platform();
const arch = os.arch() === "arm64" ? "arm64" : "x64";
const binary = platform === "windows" ? "executor.exe" : "executor";
const cachedBinary = path.join(runtimeDir, binary);
const legacyCachedBinary = path.join(binDir, platform === "win32" ? ".executor.exe" : ".executor");

const isMusl = (() => {
  if (platform !== "linux") return false;
  try { if (fs.existsSync("/etc/alpine-release")) return true; } catch {}
  try {
    const r = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" });
    if (((r.stdout || "") + (r.stderr || "")).toLowerCase().includes("musl")) return true;
  } catch {}
  return false;
})();

const assetBase = (() => {
  const base = "executor-" + platform + "-" + arch;
  if (platform === "linux" && isMusl) return base + "-musl";
  return base;
})();
const archiveName = platform === "linux" ? assetBase + ".tar.gz" : assetBase + ".zip";
const downloadUrl = githubBase + "/releases/download/v" + version + "/" + archiveName;
const archivePath = path.join(packageDir, archiveName);

const run = (command, args) => {
  const result = childProcess.spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(command + " exited with code " + result.status);
  }
};

const download = async () => {
  const response = await fetch(downloadUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error("Failed to download " + downloadUrl + " (status " + response.status + ")");
  }
  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(archivePath, Buffer.from(arrayBuffer));
};

const extract = () => {
  fs.mkdirSync(binDir, { recursive: true });
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  if (platform === "linux") {
    run("tar", ["-xzf", archivePath, "-C", runtimeDir]);
    return;
  }

  if (platform === "darwin") {
    run("unzip", ["-o", archivePath, "-d", runtimeDir]);
    return;
  }

  const command = [
    "$ErrorActionPreference = 'Stop'",
    "Expand-Archive -LiteralPath '" + archivePath.replace(/'/g, "''") + "' -DestinationPath '" + runtimeDir.replace(/'/g, "''") + "' -Force",
  ].join("; ");
  run("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command]);
};

(async () => {
  try {
    await download();
    extract();

    if (!fs.existsSync(cachedBinary)) {
      throw new Error("Expected extracted binary at " + cachedBinary);
    }

    if (fs.existsSync(legacyCachedBinary)) {
      fs.unlinkSync(legacyCachedBinary);
    }
    fs.chmodSync(cachedBinary, 0o755);
    fs.rmSync(archivePath, { force: true });
    console.log("executor: installed " + assetBase + " from GitHub Releases");
  } catch (error) {
    console.error("executor postinstall failed:", error && error.message ? error.message : error);
    process.exit(1);
  }
})();
`;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];
const singleFlag = process.argv.includes("--single");

if (command === "binary") {
  const targets = singleFlag
    ? ALL_TARGETS.filter(isCurrentPlatform)
    : ALL_TARGETS;
  const binaries = await buildBinaries(targets);
  await buildWrapperPackage(binaries);
} else if (command === "release-assets") {
  await createReleaseAssets();
} else if (command === "publish") {
  const channel = process.argv[3] ?? "latest";
  await publish(channel);
} else {
  console.log(`Usage:
  bun run build.ts binary [--single]   Build platform binaries + wrapper package
  bun run build.ts release-assets      Create .tar.gz/.zip from built binaries
  bun run build.ts publish [channel]   Publish all packages to npm`);
  process.exit(1);
}

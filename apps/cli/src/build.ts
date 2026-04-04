import { cp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliRoot = resolve(repoRoot, "apps/cli");
const webRoot = resolve(repoRoot, "apps/web");
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
  if (existsSync(webDist)) return webDist;

  console.log("Building web app...");
  const proc = Bun.spawn(["bun", "run", "build"], { cwd: webRoot, stdio: ["ignore", "inherit", "inherit"] });
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

const buildBinaries = async (targets: Target[]) => {
  const meta = await readMetadata();
  const binaries: Record<string, string> = {};

  await rm(distDir, { recursive: true, force: true });

  console.log("Generating embedded web UI bundle...");
  const embeddedWebUI = await createEmbeddedWebUISource();
  const quickJsWasmPath = resolveQuickJsWasmPath();

  for (const target of targets) {
    const name = targetPackageName(target);
    const outDir = join(distDir, name);
    const binDir = join(outDir, "bin");
    await mkdir(binDir, { recursive: true });

    console.log(`Building ${name}...`);

    await Bun.build({
      entrypoints: [join(cliRoot, "src/main.ts"), "embedded-web-ui.gen.ts"],
      minify: true,
      files: {
        "embedded-web-ui.gen.ts": embeddedWebUI,
      },
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
};

// ---------------------------------------------------------------------------
// Build wrapper npm package
// ---------------------------------------------------------------------------

const buildWrapperPackage = async (binaries: Record<string, string>) => {
  const meta = await readMetadata();
  const wrapperDir = join(distDir, meta.name);
  const binDir = join(wrapperDir, "bin");

  await mkdir(binDir, { recursive: true });

  // Node.js shim that finds + spawns the right platform binary
  await writeFile(join(binDir, "executor"), NODE_SHIM);
  await chmod(join(binDir, "executor"), 0o755);

  // Postinstall: hardlink the platform binary for faster startup
  await writeFile(join(wrapperDir, "postinstall.mjs"), POSTINSTALL_SCRIPT);

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
          postinstall: "node ./postinstall.mjs",
        },
        optionalDependencies: binaries,
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
  console.log(`  optionalDependencies: ${Object.keys(binaries).join(", ")}`);
};

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

const publish = async (channel: string) => {
  const meta = await readMetadata();

  // Publish platform packages
  for (const entry of new Bun.Glob("executor-*/package.json").scanSync({ cwd: distDir })) {
    const pkgDir = join(distDir, dirname(entry));
    console.log(`Publishing ${pkgDir}...`);
    await $`bun pm pack`.cwd(pkgDir);
    await $`npm publish *.tgz --access public --tag ${channel}`.cwd(pkgDir);
  }

  // Publish wrapper package
  const wrapperDir = join(distDir, meta.name);
  console.log(`Publishing ${wrapperDir}...`);
  await $`bun pm pack`.cwd(wrapperDir);
  await $`npm publish *.tgz --access public --tag ${channel}`.cwd(wrapperDir);
};

// ---------------------------------------------------------------------------
// GitHub release assets
// ---------------------------------------------------------------------------

const createReleaseAssets = async () => {
  for (const entry of new Bun.Glob("executor-*/package.json").scanSync({ cwd: distDir })) {
    const pkgDir = join(distDir, dirname(entry));
    const pkg = await Bun.file(join(pkgDir, "package.json")).json();
    const name = pkg.name as string;

    if (name.includes("linux")) {
      await $`tar -czf ${join(distDir, `${name}.tar.gz`)} *`.cwd(join(pkgDir, "bin"));
    } else {
      await $`zip -r ${join(distDir, `${name}.zip`)} *`.cwd(join(pkgDir, "bin"));
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
const os = require("os");

function run(target) {
  const result = childProcess.spawnSync(target, process.argv.slice(2), { stdio: "inherit" });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  process.exit(typeof result.status === "number" ? result.status : 0);
}

// Check env override
if (process.env.EXECUTOR_BIN_PATH) run(process.env.EXECUTOR_BIN_PATH);

// Check cached binary from postinstall
const scriptDir = path.dirname(fs.realpathSync(__filename));
const cached = path.join(scriptDir, ".executor");
if (fs.existsSync(cached)) run(cached);

// Resolve platform
const platformMap = { darwin: "darwin", linux: "linux", win32: "windows" };
const platform = platformMap[os.platform()] || os.platform();
const arch = os.arch() === "arm64" ? "arm64" : "x64";
const binary = platform === "windows" ? "executor.exe" : "executor";

// Detect musl
const isMusl = (() => {
  if (platform !== "linux") return false;
  try { if (fs.existsSync("/etc/alpine-release")) return true; } catch {}
  try {
    const r = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" });
    if (((r.stdout || "") + (r.stderr || "")).toLowerCase().includes("musl")) return true;
  } catch {}
  return false;
})();

// Build candidate list
const base = "executor-" + platform + "-" + arch;
const names = (() => {
  if (platform === "linux" && isMusl) {
    return [base + "-musl", base];
  }
  if (platform === "linux") {
    return [base, base + "-musl"];
  }
  return [base];
})();

// Walk up to find node_modules
function findBinary(startDir) {
  let current = startDir;
  for (;;) {
    const modules = path.join(current, "node_modules");
    if (fs.existsSync(modules)) {
      for (const name of names) {
        const candidate = path.join(modules, name, "bin", binary);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

const resolved = findBinary(scriptDir);
if (!resolved) {
  console.error("Could not find executor binary for your platform. Try installing " + names.map(n => '"' + n + '"').join(" or "));
  process.exit(1);
}
run(resolved);
`;

// ---------------------------------------------------------------------------
// Postinstall — hardlink/copy the platform binary for fast startup
// ---------------------------------------------------------------------------

const POSTINSTALL_SCRIPT = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");
const { createRequire } = require("module");

const __dirname_resolved = path.dirname(fs.realpathSync(__filename));
const require_ = createRequire(__filename);

const platformMap = { darwin: "darwin", linux: "linux", win32: "windows" };
const platform = platformMap[os.platform()] || os.platform();
const arch = os.arch() === "arm64" ? "arm64" : "x64";
const binary = platform === "windows" ? "executor.exe" : "executor";
const base = "executor-" + platform + "-" + arch;

const names = platform === "linux" ? [base, base + "-musl"] : [base];

for (const name of names) {
  try {
    const pkgJson = require_.resolve(name + "/package.json");
    const binaryPath = path.join(path.dirname(pkgJson), "bin", binary);
    if (!fs.existsSync(binaryPath)) continue;

    const target = path.join(__dirname_resolved, "bin", ".executor");
    const binDir = path.join(__dirname_resolved, "bin");
    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
    if (fs.existsSync(target)) fs.unlinkSync(target);

    try { fs.linkSync(binaryPath, target); }
    catch { fs.copyFileSync(binaryPath, target); }
    fs.chmodSync(target, 0o755);
    console.log("executor: binary linked for " + name);
    break;
  } catch {}
}
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

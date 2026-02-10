import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CONVEX_BACKEND_REPO = "get-convex/convex-backend";
const EXECUTOR_RELEASE_REPO = Bun.env.EXECUTOR_REPO ?? "RhysSullivan/assistant";
const NODE_VERSION = "22.22.0";
const CONVEX_CLI_VERSION = "1.31.7";
const CONVEX_CLIENT_HEADER = `npm-cli-${CONVEX_CLI_VERSION}`;

type HostPlatform = "linux" | "darwin";
type HostArch = "x64" | "arm64";

export interface ManagedRuntimeConfig {
  instanceName: string;
  instanceSecret: string;
  hostInterface: string;
  backendPort: number;
  siteProxyPort: number;
}

export interface ManagedRuntimeInfo {
  rootDir: string;
  backendDir: string;
  backendBinary: string;
  backendAssetName: string;
  backendDownloadUrl: string;
  dbPath: string;
  storageDir: string;
  configPath: string;
  config: ManagedRuntimeConfig;
  nodeDir: string;
  nodeBin: string;
  npmBin: string;
  npmPrefix: string;
  convexCliEntry: string;
  webDir: string;
  webServerEntry: string;
  webArtifactName: string;
  webDownloadUrl: string;
}

function hostTarget(): { platform: HostPlatform; arch: HostArch } {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error(`Unsupported platform: ${process.platform}. Supported platforms are linux and darwin.`);
  }
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Unsupported architecture: ${process.arch}. Supported architectures are x64 and arm64.`);
  }
  return { platform: process.platform, arch: process.arch };
}

function runtimeRootDir(): string {
  const configured = Bun.env.EXECUTOR_RUNTIME_DIR;
  if (configured && configured.trim().length > 0) {
    return configured;
  }
  return path.join(os.homedir(), ".executor", "runtime");
}

function backendBinaryName(): string {
  return process.platform === "win32" ? "convex-local-backend.exe" : "convex-local-backend";
}

function backendAssetName(): string {
  const target = hostTarget();
  if (target.platform === "linux" && target.arch === "x64") {
    return "convex-local-backend-x86_64-unknown-linux-gnu.zip";
  }
  if (target.platform === "linux" && target.arch === "arm64") {
    return "convex-local-backend-aarch64-unknown-linux-gnu.zip";
  }
  if (target.platform === "darwin" && target.arch === "x64") {
    return "convex-local-backend-x86_64-apple-darwin.zip";
  }
  return "convex-local-backend-aarch64-apple-darwin.zip";
}

function webAssetName(): string {
  const target = hostTarget();
  return `executor-web-${target.platform}-${target.arch}.tar.gz`;
}

function nodeArchiveName(): string {
  const target = hostTarget();
  return `node-v${NODE_VERSION}-${target.platform}-${target.arch}.tar.gz`;
}

function nodeDirectoryName(): string {
  const target = hostTarget();
  return `node-v${NODE_VERSION}-${target.platform}-${target.arch}`;
}

function npmBinaryName(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function randomHex(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return [...value].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function defaultConfig(): ManagedRuntimeConfig {
  const backendPort = Number(Bun.env.EXECUTOR_BACKEND_PORT ?? 5410);
  const siteProxyPort = Number(Bun.env.EXECUTOR_BACKEND_SITE_PORT ?? 5411);
  return {
    instanceName: Bun.env.EXECUTOR_INSTANCE_NAME ?? "anonymous-executor",
    instanceSecret: Bun.env.EXECUTOR_INSTANCE_SECRET ?? randomHex(32),
    hostInterface: Bun.env.EXECUTOR_BACKEND_INTERFACE ?? "127.0.0.1",
    backendPort,
    siteProxyPort,
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runProcess(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin?: "inherit" | "ignore";
    stdout?: "inherit" | "pipe";
    stderr?: "inherit" | "pipe";
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options?.cwd,
    env: options?.env,
    stdin: options?.stdin ?? "inherit",
    stdout: options?.stdout ?? "inherit",
    stderr: options?.stderr ?? "inherit",
  });

  const exitCode = await proc.exited;
  const stdout = options?.stdout === "pipe" ? await new Response(proc.stdout).text() : "";
  const stderr = options?.stderr === "pipe" ? await new Response(proc.stderr).text() : "";

  return { exitCode, stdout, stderr };
}

async function downloadWithFetch(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed downloading ${url} (${response.status})`);
  }

  const totalBytes = Number(response.headers.get("content-length") ?? "0");
  const totalMb = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(1) : null;
  const file = await fs.open(destinationPath, "w");
  let downloadedBytes = 0;
  let nextPercentLog = 10;
  let nextMbLog = 25;

  try {
    const reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      await file.write(chunk.value);
      downloadedBytes += chunk.value.byteLength;

      if (totalBytes > 0) {
        const percent = Math.floor((downloadedBytes / totalBytes) * 100);
        if (percent >= nextPercentLog) {
          console.log(
            `[executor] download progress ${percent}% (${(downloadedBytes / (1024 * 1024)).toFixed(1)}MB/${totalMb}MB)`,
          );
          nextPercentLog += 10;
        }
      } else {
        const mb = downloadedBytes / (1024 * 1024);
        if (mb >= nextMbLog) {
          console.log(`[executor] downloaded ${mb.toFixed(1)}MB`);
          nextMbLog += 25;
        }
      }
    }
  } finally {
    await file.close();
  }
}

async function downloadArchive(url: string, destinationPath: string): Promise<void> {
  try {
    const curl = await runProcess("curl", ["-fL", "--progress-bar", "-o", destinationPath, url], {
      stdin: "ignore",
    });
    if (curl.exitCode === 0) {
      return;
    }
  } catch {
    // curl unavailable; use fetch fallback below.
  }

  console.log("[executor] curl unavailable, falling back to fetch downloader");
  await downloadWithFetch(url, destinationPath);
}

async function extractZipArchive(archivePath: string, destinationDir: string): Promise<void> {
  try {
    const unzip = await runProcess("unzip", ["-o", archivePath, "-d", destinationDir], {
      stdin: "ignore",
    });
    if (unzip.exitCode === 0) {
      return;
    }
  } catch {
    // Fall through to python fallback.
  }

  const script = [
    "import sys, zipfile",
    "zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
  ].join(";");
  const python = await runProcess("python3", ["-c", script, archivePath, destinationDir], {
    stdin: "ignore",
  });
  if (python.exitCode !== 0) {
    throw new Error("Failed to extract zip archive. Install unzip or python3.");
  }
}

async function extractTarArchive(archivePath: string, destinationDir: string): Promise<void> {
  const untar = await runProcess("tar", ["-xzf", archivePath, "-C", destinationDir], {
    stdin: "ignore",
  });
  if (untar.exitCode !== 0) {
    throw new Error(`Failed to extract tar archive: ${archivePath}`);
  }
}

function runtimeInfo(): ManagedRuntimeInfo {
  const rootDir = runtimeRootDir();
  const backendDir = path.join(rootDir, "convex-backend");
  const backendAsset = backendAssetName();
  const backendBinary = path.join(backendDir, backendBinaryName());
  const dbPath = path.join(rootDir, "convex-data", "convex_local_backend.sqlite3");
  const storageDir = path.join(rootDir, "convex-data", "storage");
  const configPath = path.join(rootDir, "convex-backend.json");
  const nodeDir = path.join(rootDir, nodeDirectoryName());
  const nodeBin = path.join(nodeDir, "bin", "node");
  const npmPrefix = path.join(rootDir, "npm");
  const npmBin = path.join(nodeDir, "bin", npmBinaryName());
  const convexCliEntry = path.join(npmPrefix, "node_modules", "convex", "bin", "main.js");
  const webDir = path.join(rootDir, "web");
  const webArtifact = webAssetName();

  return {
    rootDir,
    backendDir,
    backendBinary,
    backendAssetName: backendAsset,
    backendDownloadUrl: `https://github.com/${CONVEX_BACKEND_REPO}/releases/latest/download/${backendAsset}`,
    dbPath,
    storageDir,
    configPath,
    config: defaultConfig(),
    nodeDir,
    nodeBin,
    npmBin,
    npmPrefix,
    convexCliEntry,
    webDir,
    webServerEntry: path.join(webDir, "server.js"),
    webArtifactName: webArtifact,
    webDownloadUrl: `https://github.com/${EXECUTOR_RELEASE_REPO}/releases/latest/download/${webArtifact}`,
  };
}

async function ensureConfig(info: ManagedRuntimeInfo): Promise<ManagedRuntimeConfig> {
  if (await pathExists(info.configPath)) {
    const raw = await fs.readFile(info.configPath, "utf8");
    const parsed = JSON.parse(raw) as ManagedRuntimeConfig;
    if (parsed.instanceName === "executor-local") {
      parsed.instanceName = "anonymous-executor";
      await fs.writeFile(info.configPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      console.log("[executor] migrated instanceName from executor-local to anonymous-executor");
    }
    return parsed;
  }

  const config = defaultConfig();
  await fs.mkdir(path.dirname(info.configPath), { recursive: true });
  await fs.writeFile(info.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

async function ensureBackendBinary(info: ManagedRuntimeInfo): Promise<void> {
  if (await pathExists(info.backendBinary)) {
    return;
  }

  await fs.mkdir(info.backendDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "executor-convex-backend-"));
  const archivePath = path.join(tempDir, info.backendAssetName);

  try {
    console.log(`[executor] downloading managed Convex backend (${info.backendAssetName})`);
    await downloadArchive(info.backendDownloadUrl, archivePath);

    console.log("[executor] extracting managed Convex backend binary");
    await extractZipArchive(archivePath, info.backendDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  if (!(await pathExists(info.backendBinary))) {
    throw new Error(`Convex backend install incomplete. Expected binary at ${info.backendBinary}`);
  }

  if (process.platform !== "win32") {
    await fs.chmod(info.backendBinary, 0o755);
  }
}

async function ensureNodeRuntime(info: ManagedRuntimeInfo): Promise<void> {
  if (await pathExists(info.nodeBin)) {
    return;
  }

  const archiveName = nodeArchiveName();
  const archiveUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "executor-node-runtime-"));
  const archivePath = path.join(tempDir, archiveName);
  try {
    await fs.mkdir(info.rootDir, { recursive: true });
    console.log(`[executor] downloading managed Node runtime (${archiveName})`);
    await downloadArchive(archiveUrl, archivePath);

    console.log("[executor] extracting managed Node runtime");
    await extractTarArchive(archivePath, info.rootDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  if (!(await pathExists(info.nodeBin))) {
    throw new Error(`Node runtime install incomplete. Expected node executable at ${info.nodeBin}`);
  }
}

async function ensureConvexCliRuntime(info: ManagedRuntimeInfo): Promise<void> {
  if (await pathExists(info.convexCliEntry)) {
    return;
  }

  await ensureNodeRuntime(info);
  await fs.mkdir(info.npmPrefix, { recursive: true });

  const env = {
    ...process.env,
    PATH: `${path.dirname(info.nodeBin)}:${process.env.PATH ?? ""}`,
  };

  console.log(`[executor] installing managed Convex CLI (${CONVEX_CLI_VERSION})`);
  const install = await runProcess(
    info.npmBin,
    [
      "install",
      "--prefix",
      info.npmPrefix,
      "--no-audit",
      "--no-fund",
      "--loglevel",
      "error",
      `convex@${CONVEX_CLI_VERSION}`,
    ],
    { env },
  );

  if (install.exitCode !== 0 || !(await pathExists(info.convexCliEntry))) {
    throw new Error("Failed to install managed Convex CLI runtime.");
  }
}

async function generateSelfHostedAdminKey(info: ManagedRuntimeInfo): Promise<string> {
  const response = await fetch("https://api.convex.dev/api/local_deployment/generate_admin_key", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Convex-Client": CONVEX_CLIENT_HEADER,
    },
    body: JSON.stringify({
      instanceName: info.config.instanceName,
      instanceSecret: info.config.instanceSecret,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed generating self-hosted admin key: ${text || response.statusText}`);
  }

  const parsed = (await response.json()) as { adminKey?: string };
  if (!parsed.adminKey) {
    throw new Error("Convex admin key generation did not return an admin key.");
  }

  return parsed.adminKey;
}

async function findProjectDir(): Promise<string | null> {
  const roots = [
    Bun.env.EXECUTOR_PROJECT_DIR,
    process.cwd(),
    path.resolve(import.meta.dir, ".."),
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));

  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(root);
    candidates.push(path.join(root, "executor"));
  }

  for (const candidate of candidates) {
    const convexDir = path.join(candidate, "convex");
    const convexConfig = path.join(convexDir, "convex.config.ts");
    const convexJson = path.join(candidate, "convex.json");
    if ((await pathExists(convexDir)) && (await pathExists(convexConfig)) && (await pathExists(convexJson))) {
      return candidate;
    }
  }

  return null;
}

async function writeBootstrapEnvFile(info: ManagedRuntimeInfo, adminKey: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "executor-convex-env-"));
  const filePath = path.join(tempDir, "selfhost.env");
  const contents = [
    `CONVEX_SELF_HOSTED_URL=http://${info.config.hostInterface}:${info.config.backendPort}`,
    `CONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}`,
  ].join("\n");
  await fs.writeFile(filePath, `${contents}\n`, "utf8");
  return filePath;
}

async function runManagedConvexCli(
  info: ManagedRuntimeInfo,
  projectDir: string,
  args: string[],
  envFilePath: string,
  options?: { stdout?: "inherit" | "pipe"; stderr?: "inherit" | "pipe" },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    PATH: `${path.dirname(info.nodeBin)}:${process.env.PATH ?? ""}`,
    CONVEX_DEPLOYMENT: "",
    CONVEX_URL: "",
    CONVEX_SITE_URL: "",
  };

  return await runProcess(
    info.nodeBin,
    [info.convexCliEntry, ...args, "--env-file", envFilePath],
    {
      cwd: projectDir,
      env,
      stdout: options?.stdout ?? "inherit",
      stderr: options?.stderr ?? "inherit",
    },
  );
}

async function waitForBackendReady(info: ManagedRuntimeInfo, timeoutMs = 30_000): Promise<void> {
  const target = `http://${info.config.hostInterface}:${info.config.backendPort}/instance_name`;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(target);
      if (response.ok) {
        return;
      }
    } catch {
      // still starting
    }
    await Bun.sleep(500);
  }

  throw new Error("Timed out waiting for local Convex backend to become ready.");
}

async function ensureProjectBootstrapped(info: ManagedRuntimeInfo): Promise<void> {
  if (Bun.env.EXECUTOR_SKIP_BOOTSTRAP === "1") {
    return;
  }

  const projectDir = await findProjectDir();
  if (!projectDir) {
    console.log("[executor] no local Convex project found; skipping function bootstrap");
    return;
  }

  await ensureConvexCliRuntime(info);
  const adminKey = await generateSelfHostedAdminKey(info);
  const envFilePath = await writeBootstrapEnvFile(info, adminKey);

  try {
    const check = await runManagedConvexCli(
      info,
      projectDir,
      ["run", "app:getClientConfig"],
      envFilePath,
      { stdout: "pipe", stderr: "pipe" },
    );

    if (check.exitCode === 0) {
      console.log("[executor] Convex functions already bootstrapped");
      return;
    }

    console.log("[executor] bootstrapping Convex functions to local backend");
    const deploy = await runManagedConvexCli(
      info,
      projectDir,
      ["dev", "--once", "--typecheck", "disable", "--codegen", "disable"],
      envFilePath,
    );

    if (deploy.exitCode !== 0) {
      throw new Error("Convex bootstrap failed while deploying local functions.");
    }
  } finally {
    await fs.rm(path.dirname(envFilePath), { recursive: true, force: true });
  }
}

async function ensureWebBundle(info: ManagedRuntimeInfo): Promise<void> {
  if (await pathExists(info.webServerEntry)) {
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "executor-web-bundle-"));
  const archivePath = path.join(tempDir, info.webArtifactName);
  const localFallbackArchive = path.resolve(import.meta.dir, "..", "dist", "release", info.webArtifactName);

  try {
    console.log(`[executor] downloading managed web bundle (${info.webArtifactName})`);
    try {
      await downloadArchive(info.webDownloadUrl, archivePath);
    } catch (error) {
      if (await pathExists(localFallbackArchive)) {
        console.log(`[executor] release web bundle unavailable, using local artifact ${localFallbackArchive}`);
        await fs.copyFile(localFallbackArchive, archivePath);
      } else {
        throw error;
      }
    }

    await fs.rm(info.webDir, { recursive: true, force: true });
    await fs.mkdir(info.webDir, { recursive: true });

    console.log("[executor] extracting managed web bundle");
    await extractTarArchive(archivePath, info.webDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  if (!(await pathExists(info.webServerEntry))) {
    throw new Error(`Web bundle install incomplete. Expected server entry at ${info.webServerEntry}`);
  }
}

function backendArgs(info: ManagedRuntimeInfo, additionalArgs: string[]): string[] {
  const cfg = info.config;
  return [
    "--instance-name",
    cfg.instanceName,
    "--instance-secret",
    cfg.instanceSecret,
    "--interface",
    cfg.hostInterface,
    "--port",
    String(cfg.backendPort),
    "--site-proxy-port",
    String(cfg.siteProxyPort),
    "--local-storage",
    info.storageDir,
    info.dbPath,
    ...additionalArgs,
  ];
}

export async function ensureManagedRuntime(): Promise<ManagedRuntimeInfo> {
  const info = runtimeInfo();
  await fs.mkdir(path.dirname(info.dbPath), { recursive: true });
  await fs.mkdir(info.storageDir, { recursive: true });
  info.config = await ensureConfig(info);
  await ensureBackendBinary(info);
  console.log("[executor] managed Convex backend runtime ready");
  return info;
}

export async function runManagedBackend(args: string[]): Promise<number> {
  const info = await ensureManagedRuntime();
  const env = {
    ...process.env,
    PATH: `${path.dirname(info.nodeBin)}:${process.env.PATH ?? ""}`,
  };

  const proc = Bun.spawn([info.backendBinary, ...backendArgs(info, args)], {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  if (args.length === 0) {
    try {
      await waitForBackendReady(info);
      await ensureProjectBootstrapped(info);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[executor] bootstrap skipped: ${message}`);
    }
  }

  return await proc.exited;
}

export async function runManagedWeb(options: { port?: number } = {}): Promise<number> {
  const info = await ensureManagedRuntime();
  try {
    await waitForBackendReady(info, 3_000);
    await ensureProjectBootstrapped(info);
  } catch {
    // Backend not running yet; web can still start and retry queries later.
  }
  await ensureNodeRuntime(info);
  await ensureWebBundle(info);

  const mcpPort = Number(Bun.env.EXECUTOR_MCP_GATEWAY_PORT ?? 5313);
  const webPort = options.port ?? Number(Bun.env.EXECUTOR_WEB_PORT ?? 5312);
  const host = Bun.env.EXECUTOR_WEB_INTERFACE ?? "127.0.0.1";

  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(webPort),
    HOSTNAME: host,
    CONVEX_URL: process.env.CONVEX_URL ?? `http://${info.config.hostInterface}:${info.config.backendPort}`,
    CONVEX_SITE_URL: process.env.CONVEX_SITE_URL ?? `http://${info.config.hostInterface}:${info.config.siteProxyPort}`,
    NEXT_PUBLIC_LOCAL_MCP_ORIGIN: process.env.NEXT_PUBLIC_LOCAL_MCP_ORIGIN ?? `http://localhost:${mcpPort}`,
  };

  const proc = await runProcess(info.nodeBin, [info.webServerEntry], {
    cwd: info.webDir,
    env,
  });
  return proc.exitCode;
}

export async function backendVersion(info: ManagedRuntimeInfo): Promise<string> {
  const version = await runProcess(info.backendBinary, ["--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (version.exitCode !== 0) {
    return "unknown";
  }
  const text = version.stdout.trim();
  return text.length > 0 ? text : "unknown";
}

export async function managedRuntimeDiagnostics(): Promise<ManagedRuntimeInfo & { backendVersion: string; convexUrl: string; convexSiteUrl: string }> {
  const info = await ensureManagedRuntime();
  const backendVer = await backendVersion(info);

  return {
    ...info,
    backendVersion: backendVer,
    convexUrl: `http://${info.config.hostInterface}:${info.config.backendPort}`,
    convexSiteUrl: `http://${info.config.hostInterface}:${info.config.siteProxyPort}`,
  };
}

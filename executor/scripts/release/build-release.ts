#!/usr/bin/env bun

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import net from "node:net";

import { managedRuntimeVersions } from "../../packages/core/src/managed/runtime-info";

type ReleaseTarget = {
  platform: "linux" | "darwin";
  arch: "x64" | "arm64";
  bunTarget: string;
};

const targets: ReleaseTarget[] = [
  { platform: "linux", arch: "x64", bunTarget: "bun-linux-x64" },
  { platform: "linux", arch: "arm64", bunTarget: "bun-linux-arm64" },
  { platform: "darwin", arch: "x64", bunTarget: "bun-darwin-x64" },
  { platform: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64" },
];

const convexBackendRepo = "get-convex/convex-backend";

function hostPlatformArch(): { platform: "linux" | "darwin"; arch: "x64" | "arm64" } {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error(`Unsupported host platform for release build: ${process.platform}`);
  }
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Unsupported host architecture for release build: ${process.arch}`);
  }
  return { platform: process.platform, arch: process.arch };
}

function archiveName(platform: ReleaseTarget["platform"], arch: ReleaseTarget["arch"]): string {
  return `executor-${platform}-${arch}.tar.gz`;
}

function webArchiveName(platform: ReleaseTarget["platform"], arch: ReleaseTarget["arch"]): string {
  return `executor-web-${platform}-${arch}.tar.gz`;
}

function runtimeArchiveName(platform: ReleaseTarget["platform"], arch: ReleaseTarget["arch"]): string {
  return `executor-runtime-${platform}-${arch}.tar.gz`;
}

function backendAssetName(target: ReleaseTarget): string {
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

function nodeArchiveName(target: ReleaseTarget): string {
  return `node-v${managedRuntimeVersions.nodeVersion}-${target.platform}-${target.arch}.tar.gz`;
}

function backendBinaryName(target: ReleaseTarget): string {
  return target.platform === "linux" || target.platform === "darwin"
    ? "convex-local-backend"
    : "convex-local-backend.exe";
}

async function sha256(filePath: string): Promise<string> {
  const bytes = await Bun.file(filePath).arrayBuffer();
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

async function runCommand(command: string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${command.join(" ")}`);
  }
}

async function runArchiveCommand(command: string[], cwd?: string): Promise<void> {
  await runCommand(command, { cwd });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url: string, destination: string): Promise<void> {
  await runCommand(["curl", "-fsSL", url, "-o", destination]);
}

async function extractZipArchive(archivePath: string, destinationDir: string): Promise<void> {
  try {
    await runCommand(["unzip", "-o", archivePath, "-d", destinationDir]);
    return;
  } catch {
    const pythonScript = [
      "import sys, zipfile",
      "zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
    ].join(";");
    await runCommand(["python3", "-c", pythonScript, archivePath, destinationDir]);
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // still starting
    }
    await Bun.sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function canBindPort(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function randomPortBase(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const base = 20000 + Math.floor(Math.random() * 20000);
    if (await canBindPort(base) && await canBindPort(base + 1) && await canBindPort(base + 2)) {
      return base;
    }
  }

  throw new Error("Unable to allocate free ports for runtime seeding");
}

type AnonymousAuthSeed = {
  privateKeyPem: string;
  publicKeyPem: string;
  apiKeySecret: string;
};

type RuntimeConfig = {
  instanceName: string;
  instanceSecret: string;
  hostInterface: string;
  backendPort: number;
  siteProxyPort: number;
};

function normalizePemForEnv(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n/g, "\\n").trim();
}

function createAnonymousAuthSeed(): AnonymousAuthSeed {
  const keyPair = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
  });

  const privateKeyPem = normalizePemForEnv(keyPair.privateKey);
  return {
    privateKeyPem,
    publicKeyPem: normalizePemForEnv(keyPair.publicKey),
    apiKeySecret: privateKeyPem,
  };
}

async function readRuntimeConfig(runtimeDir: string): Promise<RuntimeConfig> {
  const configPath = path.join(runtimeDir, "convex-backend.json");
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<RuntimeConfig>;

  if (
    typeof parsed.instanceName !== "string"
    || typeof parsed.instanceSecret !== "string"
    || typeof parsed.hostInterface !== "string"
    || typeof parsed.backendPort !== "number"
    || typeof parsed.siteProxyPort !== "number"
  ) {
    throw new Error(`Invalid runtime config at ${configPath}`);
  }

  return {
    instanceName: parsed.instanceName,
    instanceSecret: parsed.instanceSecret,
    hostInterface: parsed.hostInterface,
    backendPort: parsed.backendPort,
    siteProxyPort: parsed.siteProxyPort,
  };
}

async function generateSelfHostedAdminKey(config: RuntimeConfig): Promise<string> {
  const response = await fetch("https://api.convex.dev/api/local_deployment/generate_admin_key", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Convex-Client": managedRuntimeVersions.convexClientHeader,
    },
    body: JSON.stringify({
      instanceName: config.instanceName,
      instanceSecret: config.instanceSecret,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed generating self-hosted admin key: ${text || response.statusText}`);
  }

  const parsed = await response.json() as { adminKey?: string };
  if (!parsed.adminKey || parsed.adminKey.trim().length === 0) {
    throw new Error("Self-hosted admin key API did not return adminKey");
  }

  return parsed.adminKey;
}

async function seedManagedRuntimeState(
  rootDir: string,
  runtimeDir: string,
  config: RuntimeConfig,
  anonymousAuth: AnonymousAuthSeed,
): Promise<void> {
  const adminKey = await generateSelfHostedAdminKey(config);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "executor-seed-env-"));
  const envFilePath = path.join(tempDir, "selfhost.env");
  const envContents = [
    `CONVEX_SELF_HOSTED_URL=http://${config.hostInterface}:${config.backendPort}`,
    `CONVEX_SELF_HOSTED_ADMIN_KEY=${adminKey}`,
    "WORKOS_CLIENT_ID=disabled",
  ].join("\n");

  await fs.writeFile(envFilePath, `${envContents}\n`, "utf8");

  const envEntries: Array<{ name: string; value: string }> = [
    { name: "WORKOS_CLIENT_ID", value: "disabled" },
    { name: "ANONYMOUS_AUTH_ISSUER", value: `http://${config.hostInterface}:${config.siteProxyPort}` },
    { name: "ANONYMOUS_AUTH_PRIVATE_KEY_PEM", value: anonymousAuth.privateKeyPem },
    { name: "ANONYMOUS_AUTH_PUBLIC_KEY_PEM", value: anonymousAuth.publicKeyPem },
    { name: "MCP_API_KEY_SECRET", value: anonymousAuth.apiKeySecret },
  ];

  try {
    for (const entry of envEntries) {
      await runCommand(["bunx", "convex", "env", "set", `${entry.name}=${entry.value}`, "--env-file", envFilePath], {
        cwd: rootDir,
      });
    }

    await runCommand(["bunx", "convex", "deploy", "--yes", "--typecheck", "disable", "--codegen", "disable", "--env-file", envFilePath], {
      cwd: rootDir,
    });

    await runCommand(["bunx", "convex", "run", "app:getClientConfig", "--env-file", envFilePath], {
      cwd: rootDir,
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  await fs.writeFile(
    path.join(runtimeDir, "managed-anonymous-auth.json"),
    `${JSON.stringify({
      ANONYMOUS_AUTH_PRIVATE_KEY_PEM: anonymousAuth.privateKeyPem,
      ANONYMOUS_AUTH_PUBLIC_KEY_PEM: anonymousAuth.publicKeyPem,
      MCP_API_KEY_SECRET: anonymousAuth.apiKeySecret,
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function seedRuntimeState(rootDir: string): Promise<{ tempRoot: string; runtimeDir: string }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "executor-runtime-seed-"));
  const runtimeDir = path.join(tempRoot, "runtime");
  const basePort = await randomPortBase();
  const anonymousAuth = createAnonymousAuthSeed();
  const host = hostPlatformArch();
  const hostTarget: ReleaseTarget = {
    platform: host.platform,
    arch: host.arch,
    bunTarget: host.platform === "linux"
      ? (host.arch === "x64" ? "bun-linux-x64" : "bun-linux-arm64")
      : (host.arch === "x64" ? "bun-darwin-x64" : "bun-darwin-arm64"),
  };

  await fs.mkdir(runtimeDir, { recursive: true });
  const hostNodeArchive = path.join(tempRoot, nodeArchiveName(hostTarget));
  const hostNodeUrl = `https://nodejs.org/dist/v${managedRuntimeVersions.nodeVersion}/${nodeArchiveName(hostTarget)}`;
  await downloadFile(hostNodeUrl, hostNodeArchive);
  await runArchiveCommand(["tar", "-xzf", hostNodeArchive, "-C", runtimeDir]);

  const env = {
    ...process.env,
    EXECUTOR_SKIP_RUNTIME_IMAGE: "1",
    EXECUTOR_RUNTIME_DIR: runtimeDir,
    EXECUTOR_PROJECT_DIR: rootDir,
    EXECUTOR_BACKEND_PORT: String(basePort),
    EXECUTOR_BACKEND_SITE_PORT: String(basePort + 1),
    EXECUTOR_WEB_PORT: String(basePort + 2),
    ANONYMOUS_AUTH_PRIVATE_KEY_PEM: anonymousAuth.privateKeyPem,
    ANONYMOUS_AUTH_PUBLIC_KEY_PEM: anonymousAuth.publicKeyPem,
    MCP_API_KEY_SECRET: anonymousAuth.apiKeySecret,
  };

  const backendProc = Bun.spawn(["bun", "run", "executor.ts", "up", "--disable-beacon"], {
    cwd: rootDir,
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });

  try {
    await waitForHttp(`http://127.0.0.1:${basePort}/version`, 120_000);
    const config = await readRuntimeConfig(runtimeDir);
    await seedManagedRuntimeState(rootDir, runtimeDir, config, anonymousAuth);
  } catch (error) {
    backendProc.kill();
    await backendProc.exited;
    throw error;
  }

  backendProc.kill();
  await backendProc.exited;

  const convexDataDir = path.join(runtimeDir, "convex-data");
  if (!(await pathExists(convexDataDir))) {
    throw new Error("Runtime seeding failed: convex-data directory missing");
  }

  return { tempRoot, runtimeDir };
}

async function buildWebArtifact(rootDir: string, releaseDir: string, checksums: string[]): Promise<void> {
  const host = hostPlatformArch();
  const webAppDir = path.join(rootDir, "apps", "web");
  const webArtifactName = webArchiveName(host.platform, host.arch);
  const archivePath = path.join(releaseDir, webArtifactName);

  const webBuildEnv = {
    ...process.env,
    EXECUTOR_WEB_CONVEX_URL: "http://127.0.0.1:5410",
    EXECUTOR_WEB_CONVEX_SITE_URL: "http://127.0.0.1:5411",
  };

  await runCommand(["bunx", "next", "build"], {
    cwd: webAppDir,
    env: webBuildEnv,
  });

  const standaloneRoot = path.join(webAppDir, ".next", "standalone");
  const staticRoot = path.join(webAppDir, ".next", "static");
  const publicRoot = path.join(webAppDir, "public");
  const stageRoot = path.join(releaseDir, `executor-web-${host.platform}-${host.arch}`);
  const stagedAppRoot = path.join(stageRoot, "executor", "apps", "web");

  if (!(await pathExists(standaloneRoot))) {
    throw new Error(`Missing standalone output at ${standaloneRoot}. Ensure next build output is standalone.`);
  }

  await fs.rm(stageRoot, { recursive: true, force: true });
  await fs.mkdir(stageRoot, { recursive: true });

  await fs.cp(standaloneRoot, stageRoot, { recursive: true, dereference: true });
  const bundledNodeModules = path.join(stageRoot, "node_modules", ".bun", "node_modules");
  if (await pathExists(bundledNodeModules)) {
    await fs.cp(bundledNodeModules, path.join(stageRoot, "node_modules"), { recursive: true });
  }
  await fs.mkdir(path.join(stagedAppRoot, ".next"), { recursive: true });
  await fs.cp(staticRoot, path.join(stagedAppRoot, ".next", "static"), { recursive: true });
  if (await pathExists(publicRoot)) {
    await fs.cp(publicRoot, path.join(stagedAppRoot, "public"), { recursive: true });
  }

  await Bun.write(
    path.join(stageRoot, "server.js"),
    "process.chdir(__dirname + '/executor/apps/web');\nrequire('./executor/apps/web/server.js');\n",
  );

  await runArchiveCommand(["tar", "-czf", archivePath, "-C", stageRoot, "."]);
  const digest = await sha256(archivePath);
  checksums.push(`${digest}  ${path.basename(archivePath)}`);
  console.log(`built ${webArtifactName}`);

  for (const target of targets) {
    if (target.platform === host.platform && target.arch === host.arch) {
      continue;
    }

    const targetArtifactName = webArchiveName(target.platform, target.arch);
    const targetArchivePath = path.join(releaseDir, targetArtifactName);
    await fs.copyFile(archivePath, targetArchivePath);

    const targetDigest = await sha256(targetArchivePath);
    checksums.push(`${targetDigest}  ${targetArtifactName}`);
    console.log(`aliased ${targetArtifactName} from ${webArtifactName}`);
  }
}

async function buildRuntimeArtifact(rootDir: string, releaseDir: string, checksums: string[]): Promise<void> {
  const seeded = await seedRuntimeState(rootDir);
  const convexDataDir = path.join(seeded.runtimeDir, "convex-data");
  const managedAnonymousAuthFile = path.join(seeded.runtimeDir, "managed-anonymous-auth.json");

  const tempDownloads = await fs.mkdtemp(path.join(os.tmpdir(), "executor-runtime-build-"));

  try {
    for (const target of targets) {
      const stageRoot = path.join(releaseDir, `executor-runtime-${target.platform}-${target.arch}`);
      const artifactPath = path.join(releaseDir, runtimeArchiveName(target.platform, target.arch));

      await fs.rm(stageRoot, { recursive: true, force: true });
      await fs.mkdir(stageRoot, { recursive: true });

      await fs.cp(convexDataDir, path.join(stageRoot, "convex-data"), { recursive: true });
      if (await pathExists(managedAnonymousAuthFile)) {
        await fs.copyFile(managedAnonymousAuthFile, path.join(stageRoot, "managed-anonymous-auth.json"));
      }

      const backendArchive = path.join(tempDownloads, backendAssetName(target));
      const backendUrl = `https://github.com/${convexBackendRepo}/releases/latest/download/${backendAssetName(target)}`;
      await downloadFile(backendUrl, backendArchive);
      await fs.mkdir(path.join(stageRoot, "convex-backend"), { recursive: true });
      await extractZipArchive(backendArchive, path.join(stageRoot, "convex-backend"));

      const backendBinary = path.join(stageRoot, "convex-backend", backendBinaryName(target));
      if (!(await pathExists(backendBinary))) {
        throw new Error(`Runtime artifact missing backend binary after extraction: ${backendBinary}`);
      }
      await fs.chmod(backendBinary, 0o755);

      const nodeArchive = path.join(tempDownloads, nodeArchiveName(target));
      const nodeUrl = `https://nodejs.org/dist/v${managedRuntimeVersions.nodeVersion}/${nodeArchiveName(target)}`;
      await downloadFile(nodeUrl, nodeArchive);
      await runArchiveCommand(["tar", "-xzf", nodeArchive, "-C", stageRoot]);

      const nodeDir = path.join(stageRoot, `node-v${managedRuntimeVersions.nodeVersion}-${target.platform}-${target.arch}`);
      if (!(await pathExists(path.join(nodeDir, "bin", "node")))) {
        throw new Error(`Runtime artifact missing extracted node runtime: ${nodeDir}`);
      }

      const webArchive = path.join(releaseDir, webArchiveName(target.platform, target.arch));
      if (!(await pathExists(webArchive))) {
        throw new Error(`Missing web artifact for runtime packaging: ${webArchive}`);
      }
      const webStage = path.join(tempDownloads, `web-${target.platform}-${target.arch}`);
      await fs.rm(webStage, { recursive: true, force: true });
      await fs.mkdir(webStage, { recursive: true });
      await runArchiveCommand(["tar", "-xzf", webArchive, "-C", webStage]);
      await fs.cp(webStage, path.join(stageRoot, "web"), { recursive: true });

      if (!(await pathExists(path.join(stageRoot, "web", "server.js")))) {
        throw new Error(`Runtime artifact missing web server entry for ${target.platform}-${target.arch}`);
      }

      await runArchiveCommand(["tar", "-czf", artifactPath, "-C", stageRoot, "."]);
      const digest = await sha256(artifactPath);
      checksums.push(`${digest}  ${path.basename(artifactPath)}`);
      console.log(`built ${path.basename(artifactPath)}`);
    }
  } finally {
    await fs.rm(tempDownloads, { recursive: true, force: true });
    await fs.rm(seeded.tempRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const rootDir = path.resolve(import.meta.dir, "..", "..");
  const releaseDir = path.join(rootDir, "dist", "release");

  await fs.rm(releaseDir, { recursive: true, force: true });
  await fs.mkdir(releaseDir, { recursive: true });

  const checksums: string[] = [];

  for (const target of targets) {
    const dirName = `executor-${target.platform}-${target.arch}`;
    const bundleDir = path.join(releaseDir, dirName);
    const binDir = path.join(bundleDir, "bin");
    const binName = "executor";
    const binPath = path.join(binDir, binName);

    await fs.mkdir(binDir, { recursive: true });

    const build = await Bun.build({
      entrypoints: [path.join(rootDir, "executor.ts")],
      compile: {
        target: target.bunTarget as never,
        outfile: binPath,
      },
    });

    if (!build.success) {
      const logs = build.logs.map((log) => log.message).join("\n");
      throw new Error(`Failed to compile target ${target.bunTarget}\n${logs}`);
    }

    const archivePath = path.join(releaseDir, archiveName(target.platform, target.arch));
    await runArchiveCommand(["tar", "-czf", archivePath, "-C", binDir, binName]);

    const digest = await sha256(archivePath);
    checksums.push(`${digest}  ${path.basename(archivePath)}`);
    console.log(`built ${path.basename(archivePath)}`);
  }

  await buildWebArtifact(rootDir, releaseDir, checksums);
  await buildRuntimeArtifact(rootDir, releaseDir, checksums);

  await Bun.write(path.join(releaseDir, "checksums.txt"), `${checksums.join("\n")}\n`);
  console.log(`wrote ${path.join("dist", "release", "checksums.txt")}`);
}

await main();

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import type { ManagedRuntimeConfig, ManagedRuntimeInfo } from "../managed-runtime";

const managedRuntimeConfigSchema = z.object({
  instanceName: z.string().min(1),
  instanceSecret: z.string().min(1),
  hostInterface: z.string().min(1),
  backendPort: z.number().int(),
  siteProxyPort: z.number().int(),
});

const CONVEX_BACKEND_REPO = "get-convex/convex-backend";
const EXECUTOR_RELEASE_REPO = Bun.env.EXECUTOR_REPO ?? "RhysSullivan/executor";
const NODE_VERSION = "22.22.0";
const CONVEX_CLI_VERSION = "1.31.7";
const CONVEX_CLIENT_HEADER = `npm-cli-${CONVEX_CLI_VERSION}`;

type HostPlatform = "linux" | "darwin";
type HostArch = "x64" | "arm64";

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

function runtimeAssetName(): string {
  const target = hostTarget();
  return `executor-runtime-${target.platform}-${target.arch}.tar.gz`;
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

function parseManagedRuntimeConfig(value: unknown): ManagedRuntimeConfig | null {
  const parsed = managedRuntimeConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function nodeArchiveName(): string {
  const target = hostTarget();
  return `node-v${NODE_VERSION}-${target.platform}-${target.arch}.tar.gz`;
}

export function runtimeInfo(): ManagedRuntimeInfo {
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
  const runtimeArtifact = runtimeAssetName();

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
    runtimeArtifactName: runtimeArtifact,
    runtimeDownloadUrl: `https://github.com/${EXECUTOR_RELEASE_REPO}/releases/latest/download/${runtimeArtifact}`,
  };
}

export async function ensureConfig(info: ManagedRuntimeInfo): Promise<ManagedRuntimeConfig> {
  if (await pathExists(info.configPath)) {
    const raw = await fs.readFile(info.configPath, "utf8");
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(raw);
    } catch {
      parsedValue = null;
    }
    const parsed = parseManagedRuntimeConfig(parsedValue);

    if (!parsed) {
      const config = defaultConfig();
      await fs.writeFile(info.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      console.warn(`[executor] replaced invalid runtime config at ${info.configPath}`);
      return config;
    }

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

export function backendArgs(info: ManagedRuntimeInfo, additionalArgs: string[]): string[] {
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

export const managedRuntimeVersions = {
  convexCliVersion: CONVEX_CLI_VERSION,
  convexClientHeader: CONVEX_CLIENT_HEADER,
  nodeVersion: NODE_VERSION,
};

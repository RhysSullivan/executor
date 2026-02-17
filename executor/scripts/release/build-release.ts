#!/usr/bin/env bun

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

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

function hostPlatformArch(): { platform: "linux" | "darwin"; arch: "x64" | "arm64" } {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error(`Unsupported host platform for web artifact build: ${process.platform}`);
  }
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Unsupported host architecture for web artifact build: ${process.arch}`);
  }
  return { platform: process.platform, arch: process.arch };
}

function archiveName(platform: ReleaseTarget["platform"], arch: ReleaseTarget["arch"]): string {
  return `executor-${platform}-${arch}.tar.gz`;
}

function webArchiveName(platform: ReleaseTarget["platform"], arch: ReleaseTarget["arch"]): string {
  return `executor-web-${platform}-${arch}.tar.gz`;
}

function bootstrapArchiveName(): string {
  return "executor-bootstrap-project.tar.gz";
}

async function sha256(filePath: string): Promise<string> {
  const bytes = await Bun.file(filePath).arrayBuffer();
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

async function runArchiveCommand(command: string[], cwd?: string): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${command.join(" ")}`);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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

async function buildBootstrapProjectArtifact(rootDir: string, releaseDir: string, checksums: string[]): Promise<void> {
  const monorepoRoot = path.resolve(rootDir, "..");
  const archivePath = path.join(releaseDir, bootstrapArchiveName());

  await runCommand(
    [
      "git",
      "archive",
      "--format=tar.gz",
      "--prefix=executor/",
      `--output=${archivePath}`,
      "HEAD:executor",
    ],
    { cwd: monorepoRoot },
  );

  const digest = await sha256(archivePath);
  checksums.push(`${digest}  ${path.basename(archivePath)}`);
  console.log(`built ${path.basename(archivePath)}`);
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
  await buildBootstrapProjectArtifact(rootDir, releaseDir, checksums);

  await Bun.write(path.join(releaseDir, "checksums.txt"), `${checksums.join("\n")}\n`);
  console.log(`wrote ${path.join("dist", "release", "checksums.txt")}`);
}

await main();

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ManagedRuntimeInfo } from "../managed-runtime";
import { downloadArchive, extractTarArchive, extractZipArchive } from "./runtime-archives";
import { managedRuntimeVersions, nodeArchiveName, pathExists } from "./runtime-info";
import { runProcess } from "./runtime-process";

function runtimeImageLocalFallback(info: ManagedRuntimeInfo): string {
  return path.resolve(import.meta.dir, "..", "..", "..", "..", "dist", "release", info.runtimeArtifactName);
}

async function runtimeImageReady(info: ManagedRuntimeInfo): Promise<boolean> {
  return await pathExists(info.backendBinary)
    && await pathExists(info.nodeBin)
    && await pathExists(info.webServerEntry)
    && await pathExists(info.dbPath);
}

async function hasDirectoryEntries(targetDir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(targetDir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

export async function ensureRuntimeImage(info: ManagedRuntimeInfo): Promise<void> {
  if (await runtimeImageReady(info)) {
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "executor-runtime-image-"));
  const archivePath = path.join(tempDir, info.runtimeArtifactName);
  const extractRoot = path.join(tempDir, "extracted");
  const fallbackArchive = runtimeImageLocalFallback(info);

  try {
    console.log(`[executor] downloading managed runtime image (${info.runtimeArtifactName})`);
    try {
      await downloadArchive(info.runtimeDownloadUrl, archivePath);
    } catch (error) {
      if (await pathExists(fallbackArchive)) {
        console.log(`[executor] release runtime image unavailable, using local artifact ${fallbackArchive}`);
        await fs.copyFile(fallbackArchive, archivePath);
      } else {
        throw error;
      }
    }

    await fs.mkdir(extractRoot, { recursive: true });
    console.log("[executor] extracting managed runtime image");
    await extractTarArchive(archivePath, extractRoot);

    const extractedBackendDir = path.join(extractRoot, "convex-backend");
    const extractedWebDir = path.join(extractRoot, "web");
    const extractedConvexDataDir = path.join(extractRoot, "convex-data");
    const extractedNpmDir = path.join(extractRoot, "npm");
    const extractedAnonymousAuthFile = path.join(extractRoot, "managed-anonymous-auth.json");

    const extractedNodeDirs = (await fs.readdir(extractRoot))
      .filter((entry) => entry.startsWith("node-v"))
      .map((entry) => path.join(extractRoot, entry));

    if (
      !(await pathExists(path.join(extractedBackendDir, path.basename(info.backendBinary))))
      || !(await pathExists(path.join(extractedWebDir, "server.js")))
      || extractedNodeDirs.length === 0
      || !(await pathExists(extractedConvexDataDir))
    ) {
      throw new Error(`Runtime image did not contain expected runtime directories: ${info.runtimeArtifactName}`);
    }

    await fs.mkdir(info.rootDir, { recursive: true });

    await fs.rm(info.backendDir, { recursive: true, force: true });
    await fs.cp(extractedBackendDir, info.backendDir, { recursive: true });

    await fs.rm(info.webDir, { recursive: true, force: true });
    await fs.cp(extractedWebDir, info.webDir, { recursive: true });

    if (await pathExists(extractedNpmDir)) {
      await fs.rm(info.npmPrefix, { recursive: true, force: true });
      await fs.cp(extractedNpmDir, info.npmPrefix, { recursive: true });
    }

    const existingNodeDirs = (await fs.readdir(info.rootDir).catch(() => []))
      .filter((entry) => entry.startsWith("node-v"));
    for (const nodeDir of existingNodeDirs) {
      await fs.rm(path.join(info.rootDir, nodeDir), { recursive: true, force: true });
    }
    for (const extractedNodeDir of extractedNodeDirs) {
      await fs.cp(extractedNodeDir, path.join(info.rootDir, path.basename(extractedNodeDir)), { recursive: true });
    }

    const preserveExistingData = await hasDirectoryEntries(path.dirname(info.dbPath));

    if (!preserveExistingData) {
      await fs.rm(path.dirname(info.dbPath), { recursive: true, force: true });
      await fs.cp(extractedConvexDataDir, path.dirname(info.dbPath), { recursive: true });
    }

    const managedAnonymousAuthTarget = path.join(info.rootDir, "managed-anonymous-auth.json");
    if (!preserveExistingData || !(await pathExists(managedAnonymousAuthTarget))) {
      if (await pathExists(extractedAnonymousAuthFile)) {
        await fs.copyFile(extractedAnonymousAuthFile, managedAnonymousAuthTarget);
        await fs.chmod(managedAnonymousAuthTarget, 0o600);
      }
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  if (!(await runtimeImageReady(info))) {
    throw new Error(`Runtime image install incomplete. Expected runtime assets under ${info.rootDir}`);
  }
}

export async function ensureBackendBinary(info: ManagedRuntimeInfo): Promise<void> {
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

export async function ensureNodeRuntime(info: ManagedRuntimeInfo): Promise<void> {
  if (await pathExists(info.nodeBin)) {
    return;
  }

  const archiveName = nodeArchiveName();
  const archiveUrl = `https://nodejs.org/dist/v${managedRuntimeVersions.nodeVersion}/${archiveName}`;

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

export async function ensureConvexCliRuntime(info: ManagedRuntimeInfo): Promise<void> {
  if (await pathExists(info.convexCliEntry)) {
    return;
  }

  await ensureNodeRuntime(info);
  await fs.mkdir(info.npmPrefix, { recursive: true });

  const env = {
    ...process.env,
    PATH: `${path.dirname(info.nodeBin)}:${process.env.PATH ?? ""}`,
  };

  console.log(`[executor] installing managed Convex CLI (${managedRuntimeVersions.convexCliVersion})`);
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
      `convex@${managedRuntimeVersions.convexCliVersion}`,
    ],
    { env },
  );

  if (install.exitCode !== 0 || !(await pathExists(info.convexCliEntry))) {
    throw new Error("Failed to install managed Convex CLI runtime.");
  }
}

export async function ensureWebBundle(info: ManagedRuntimeInfo): Promise<void> {
  if (await pathExists(info.webServerEntry)) {
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "executor-web-bundle-"));
  const archivePath = path.join(tempDir, info.webArtifactName);
  const localFallbackArchive = path.resolve(import.meta.dir, "..", "..", "..", "..", "dist", "release", info.webArtifactName);

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

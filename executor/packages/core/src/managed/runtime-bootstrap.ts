import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { z } from "zod";

import type { ManagedRuntimeInfo } from "../managed-runtime";
import { managedRuntimeVersions, pathExists } from "./runtime-info";
import { ensureConvexCliRuntime } from "./runtime-installation";
import { runProcess } from "./runtime-process";

const adminKeyResponseSchema = z.object({
  adminKey: z.string().min(1),
});

const convexJsonSchema = z.object({
  functions: z.string().optional(),
});

type BootstrapDependency = {
  packageName: string;
  installSpecifier?: string;
};

const BOOTSTRAP_REQUIRED_DEPENDENCIES: BootstrapDependency[] = [
  { packageName: "convex" },
  { packageName: "@convex-dev/migrations" },
  { packageName: "@convex-dev/stripe" },
  { packageName: "@convex-dev/workos-authkit" },
  { packageName: "@apidevtools/swagger-parser" },
  { packageName: "@workos-inc/node" },
  { packageName: "convex-helpers" },
  { packageName: "jose" },
  { packageName: "openapi-typescript" },
  { packageName: "zod", installSpecifier: "zod@^3.25.0" },
  { packageName: "graphql" },
  { packageName: "better-result" },
  { packageName: "@modelcontextprotocol/sdk" },
];

const managedAnonymousAuthEnvFileName = "managed-anonymous-auth.json";

type ManagedAnonymousAuthEnv = {
  ANONYMOUS_AUTH_PRIVATE_KEY_PEM: string;
  ANONYMOUS_AUTH_PUBLIC_KEY_PEM: string;
  MCP_API_KEY_SECRET: string;
};

function trimEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function normalizePemForEnv(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n/g, "\\n").trim();
}

function resolveAnonymousAuthFromProcessEnv(): ManagedAnonymousAuthEnv | null {
  const privateKeyPem = trimEnv("ANONYMOUS_AUTH_PRIVATE_KEY_PEM");
  const publicKeyPem = trimEnv("ANONYMOUS_AUTH_PUBLIC_KEY_PEM");
  if (!privateKeyPem || !publicKeyPem) {
    return null;
  }

  const apiKeySecret = trimEnv("MCP_API_KEY_SECRET") ?? privateKeyPem;
  return {
    ANONYMOUS_AUTH_PRIVATE_KEY_PEM: normalizePemForEnv(privateKeyPem),
    ANONYMOUS_AUTH_PUBLIC_KEY_PEM: normalizePemForEnv(publicKeyPem),
    MCP_API_KEY_SECRET: normalizePemForEnv(apiKeySecret),
  };
}

async function readManagedAnonymousAuthEnv(info: ManagedRuntimeInfo): Promise<ManagedAnonymousAuthEnv | null> {
  const filePath = path.join(info.rootDir, managedAnonymousAuthEnvFileName);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ManagedAnonymousAuthEnv>;

    if (
      typeof parsed.ANONYMOUS_AUTH_PRIVATE_KEY_PEM !== "string"
      || typeof parsed.ANONYMOUS_AUTH_PUBLIC_KEY_PEM !== "string"
      || typeof parsed.MCP_API_KEY_SECRET !== "string"
    ) {
      return null;
    }

    if (
      parsed.ANONYMOUS_AUTH_PRIVATE_KEY_PEM.trim().length === 0
      || parsed.ANONYMOUS_AUTH_PUBLIC_KEY_PEM.trim().length === 0
      || parsed.MCP_API_KEY_SECRET.trim().length === 0
    ) {
      return null;
    }

    return {
      ANONYMOUS_AUTH_PRIVATE_KEY_PEM: parsed.ANONYMOUS_AUTH_PRIVATE_KEY_PEM.trim(),
      ANONYMOUS_AUTH_PUBLIC_KEY_PEM: parsed.ANONYMOUS_AUTH_PUBLIC_KEY_PEM.trim(),
      MCP_API_KEY_SECRET: parsed.MCP_API_KEY_SECRET.trim(),
    };
  } catch {
    return null;
  }
}

function generateManagedAnonymousAuthEnv(): ManagedAnonymousAuthEnv {
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
    ANONYMOUS_AUTH_PRIVATE_KEY_PEM: privateKeyPem,
    ANONYMOUS_AUTH_PUBLIC_KEY_PEM: normalizePemForEnv(keyPair.publicKey),
    MCP_API_KEY_SECRET: normalizePemForEnv(trimEnv("MCP_API_KEY_SECRET") ?? privateKeyPem),
  };
}

async function writeManagedAnonymousAuthEnv(info: ManagedRuntimeInfo, env: ManagedAnonymousAuthEnv): Promise<void> {
  const filePath = path.join(info.rootDir, managedAnonymousAuthEnvFileName);
  await fs.mkdir(info.rootDir, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(env, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function resolveManagedAnonymousAuthEnv(info: ManagedRuntimeInfo): Promise<ManagedAnonymousAuthEnv> {
  const fromProcess = resolveAnonymousAuthFromProcessEnv();
  if (fromProcess) {
    return fromProcess;
  }

  const fromDisk = await readManagedAnonymousAuthEnv(info);
  if (fromDisk) {
    if (trimEnv("MCP_API_KEY_SECRET")) {
      return {
        ...fromDisk,
        MCP_API_KEY_SECRET: normalizePemForEnv(trimEnv("MCP_API_KEY_SECRET") ?? fromDisk.MCP_API_KEY_SECRET),
      };
    }
    return fromDisk;
  }

  const generated = generateManagedAnonymousAuthEnv();
  await writeManagedAnonymousAuthEnv(info, generated);
  return generated;
}

async function seedManagedRuntimeEnvVars(
  info: ManagedRuntimeInfo,
  projectDir: string,
  envFilePath: string,
): Promise<void> {
  const anonymousAuthEnv = await resolveManagedAnonymousAuthEnv(info);
  const envEntries: Array<{ name: string; value: string }> = [
    { name: "WORKOS_CLIENT_ID", value: "disabled" },
    { name: "ANONYMOUS_AUTH_PRIVATE_KEY_PEM", value: anonymousAuthEnv.ANONYMOUS_AUTH_PRIVATE_KEY_PEM },
    { name: "ANONYMOUS_AUTH_PUBLIC_KEY_PEM", value: anonymousAuthEnv.ANONYMOUS_AUTH_PUBLIC_KEY_PEM },
    { name: "MCP_API_KEY_SECRET", value: anonymousAuthEnv.MCP_API_KEY_SECRET },
  ];

  for (const entry of envEntries) {
    const seeded = await runManagedConvexCli(
      info,
      projectDir,
      ["env", "set", `${entry.name}=${entry.value}`],
      envFilePath,
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    if (seeded.exitCode !== 0) {
      const detail = seeded.stderr.trim() || seeded.stdout.trim() || "unknown error";
      console.warn(`[executor] could not seed ${entry.name} in local backend env: ${detail}`);
    }
  }
}

async function generateSelfHostedAdminKey(info: ManagedRuntimeInfo): Promise<string> {
  const response = await fetch("https://api.convex.dev/api/local_deployment/generate_admin_key", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Convex-Client": managedRuntimeVersions.convexClientHeader,
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

  const parsed = adminKeyResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Convex admin key generation did not return an admin key.");
  }

  return parsed.data.adminKey;
}

async function hasAnyPath(paths: string[]): Promise<boolean> {
  for (const candidate of paths) {
    if (await pathExists(candidate)) {
      return true;
    }
  }
  return false;
}

function getConfigCandidates(baseDir: string): string[] {
  return [
    path.join(baseDir, "convex.config.ts"),
    path.join(baseDir, "convex.config.js"),
    path.join(baseDir, "convex.config.mts"),
    path.join(baseDir, "convex.config.mjs"),
    path.join(baseDir, "convex.config.cts"),
    path.join(baseDir, "convex.config.cjs"),
  ];
}

async function getConfiguredFunctionsPath(candidate: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(candidate, "convex.json"), "utf8");
    const parsed = convexJsonSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || !parsed.data.functions) {
      return null;
    }

    const value = parsed.data.functions.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function hasConvexProjectConfig(candidate: string): Promise<boolean> {
  const convexJson = path.join(candidate, "convex.json");
  if (!(await pathExists(convexJson))) {
    return false;
  }

  if (await hasAnyPath(getConfigCandidates(candidate))) {
    return true;
  }

  const configuredFunctionsPath = await getConfiguredFunctionsPath(candidate);
  if (!configuredFunctionsPath) {
    return false;
  }

  const resolvedFunctionsPath = path.isAbsolute(configuredFunctionsPath)
    ? configuredFunctionsPath
    : path.resolve(candidate, configuredFunctionsPath);
  return await hasAnyPath(getConfigCandidates(resolvedFunctionsPath));
}

async function findProjectDir(info?: ManagedRuntimeInfo): Promise<string | null> {
  const roots = [
    Bun.env.EXECUTOR_PROJECT_DIR,
    process.cwd(),
    path.resolve(import.meta.dir, ".."),
    info ? path.join(info.rootDir, "bootstrap-project") : null,
    info ? path.join(info.rootDir, "bootstrap-project", "executor") : null,
  ].filter((value): value is string => Boolean(value && value.trim().length > 0));

  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(root);
    candidates.push(path.join(root, "executor"));
  }

  for (const candidate of candidates) {
    if (await hasConvexProjectConfig(candidate)) {
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
    "WORKOS_CLIENT_ID=disabled",
  ].join("\n");
  await fs.writeFile(filePath, `${contents}\n`, "utf8");
  return filePath;
}

async function hasBootstrapDependencies(projectDir: string): Promise<boolean> {
  const nodeModulesDir = path.join(projectDir, "node_modules");
  if (!(await pathExists(nodeModulesDir))) {
    return false;
  }

  for (const dependency of BOOTSTRAP_REQUIRED_DEPENDENCIES) {
    const dependencyPath = path.join(nodeModulesDir, ...dependency.packageName.split("/"));
    if (!(await pathExists(dependencyPath))) {
      return false;
    }
  }

  return true;
}

async function ensureProjectDependencies(info: ManagedRuntimeInfo, projectDir: string): Promise<void> {
  const bootstrapRelative = path.relative(path.join(info.rootDir, "bootstrap-project"), projectDir);
  const isRuntimeBootstrapProject = !bootstrapRelative.startsWith("..") && !path.isAbsolute(bootstrapRelative);

  if (!isRuntimeBootstrapProject) {
    return;
  }

  if (await hasBootstrapDependencies(projectDir)) {
    return;
  }

  const env = {
    ...process.env,
    PATH: `${path.dirname(info.nodeBin)}:${process.env.PATH ?? ""}`,
  };

  console.log(`[executor] installing bootstrap dependencies in ${projectDir}`);
  const install = await runProcess(
    info.npmBin,
    [
      "install",
      "--prefix",
      projectDir,
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--loglevel",
      "error",
      "--omit",
      "dev",
      "--ignore-scripts",
      ...BOOTSTRAP_REQUIRED_DEPENDENCIES.map((dependency) => dependency.installSpecifier ?? dependency.packageName),
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );

  if (install.exitCode !== 0) {
    const detail = install.stderr.trim() || install.stdout.trim() || `exit ${install.exitCode}`;
    throw new Error(`Failed installing bootstrap dependencies in ${projectDir}: ${detail}`);
  }

  if (!(await hasBootstrapDependencies(projectDir))) {
    throw new Error(`Bootstrap dependency install completed but dependencies are still missing in ${projectDir}`);
  }
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

export async function waitForBackendReady(info: ManagedRuntimeInfo, timeoutMs = 30_000): Promise<void> {
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

export type BootstrapHealth = {
  state: "ready" | "no_project" | "missing_functions" | "check_failed";
  projectDir?: string;
  detail?: string;
};

export async function checkBootstrapHealth(info: ManagedRuntimeInfo): Promise<BootstrapHealth> {
  const projectDir = await findProjectDir(info);
  if (!projectDir) {
    return { state: "no_project" };
  }

  await ensureConvexCliRuntime(info);
  const adminKey = await generateSelfHostedAdminKey(info);
  const envFilePath = await writeBootstrapEnvFile(info, adminKey);

  try {
    await seedManagedRuntimeEnvVars(info, projectDir, envFilePath);

    const check = await runManagedConvexCli(info, projectDir, ["run", "app:getClientConfig"], envFilePath, {
      stdout: "pipe",
      stderr: "pipe",
    });

    if (check.exitCode === 0) {
      return { state: "ready", projectDir };
    }

    const detail = check.stderr.trim() || check.stdout.trim() || `exit ${check.exitCode}`;
    return { state: "missing_functions", projectDir, detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { state: "check_failed", projectDir, detail };
  } finally {
    await fs.rm(path.dirname(envFilePath), { recursive: true, force: true });
  }
}

export async function ensureProjectBootstrapped(info: ManagedRuntimeInfo): Promise<void> {
  if (Bun.env.EXECUTOR_SKIP_BOOTSTRAP === "1") {
    return;
  }

  const check = await checkBootstrapHealth(info);

  if (check.state === "no_project") {
    console.log("[executor] no local Convex project found; skipping function bootstrap");
    return;
  }

  if (check.state === "ready") {
    console.log("[executor] Convex functions already bootstrapped");
    return;
  }

  if (check.state === "check_failed") {
    const detail = check.detail ? `: ${check.detail}` : "";
    throw new Error(`Convex bootstrap preflight failed${detail}`);
  }

  const projectDir = check.projectDir;
  if (!projectDir) {
    throw new Error("Convex bootstrap failed to resolve project directory.");
  }

  await ensureProjectDependencies(info, projectDir);

  const adminKey = await generateSelfHostedAdminKey(info);
  const envFilePath = await writeBootstrapEnvFile(info, adminKey);

  try {
    await seedManagedRuntimeEnvVars(info, projectDir, envFilePath);

    console.log("[executor] bootstrapping Convex functions to local backend");
    const deploy = await runManagedConvexCli(
      info,
      projectDir,
      ["deploy", "--yes", "--typecheck", "disable", "--codegen", "disable"],
      envFilePath,
      { stdout: "pipe", stderr: "pipe" },
    );

    if (deploy.exitCode !== 0) {
      const detail = deploy.stderr.trim() || deploy.stdout.trim() || "unknown deploy error";
      throw new Error(`Convex bootstrap failed while deploying local functions: ${detail}`);
    }
  } finally {
    await fs.rm(path.dirname(envFilePath), { recursive: true, force: true });
  }
}

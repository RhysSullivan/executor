#!/usr/bin/env bun

import assert from "node:assert/strict";
import { ConvexHttpClient } from "convex/browser";
import { $ } from "bun";
import { api } from "../../../packages/database/convex/_generated/api";

type RuntimeId = "local-bun" | "cloudflare-worker-loader";
const EXECUTOR_ROOT = new URL("../../../", import.meta.url).pathname;
const DATABASE_ROOT = new URL("../../../packages/database/", import.meta.url).pathname;

function parseArgs(argv: string[]): {
  runtimeId?: RuntimeId;
  timeoutMs: number;
  deployWorker: boolean;
  deployConvex: boolean;
} {
  let runtimeId: RuntimeId | undefined;
  let timeoutMs = 120_000;
  let deployWorker = false;
  let deployConvex = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runtime") {
      const value = argv[index + 1];
      if (value !== "local-bun" && value !== "cloudflare-worker-loader") {
        throw new Error("--runtime must be one of: local-bun, cloudflare-worker-loader");
      }
      runtimeId = value;
      index += 1;
      continue;
    }

    if (arg === "--timeout-ms") {
      const value = Number.parseInt(argv[index + 1] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--timeout-ms must be a positive integer");
      }
      timeoutMs = value;
      index += 1;
      continue;
    }

    if (arg === "--deploy-worker") {
      deployWorker = true;
      continue;
    }

    if (arg === "--deploy-convex") {
      deployConvex = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { runtimeId, timeoutMs, deployWorker, deployConvex };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function makeClient(convexUrl: string): ConvexHttpClient {
  return new ConvexHttpClient(convexUrl, {
    skipConvexDeploymentUrlCheck: true,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseWorkersDevUrl(output: string): string | null {
  const match = output.match(/https:\/\/[\w.-]+\.workers\.dev/);
  return match ? match[0] : null;
}

function isHostedConvexUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.trim().toLowerCase();
    return hostname.endsWith(".convex.cloud") || hostname.endsWith(".convex.site");
  } catch {
    return false;
  }
}

async function deployCloudflareWorkerAndGetUrl(): Promise<string> {
  console.log("[storage:smoke:execute-flow] deploying runner-sandbox-host...");
  const output = await $`bun run --cwd packages/runner-sandbox-host deploy`
    .cwd(EXECUTOR_ROOT)
    .env(process.env)
    .text();
  console.log(output.trim());

  const url = parseWorkersDevUrl(output);
  if (!url) {
    throw new Error("Could not parse workers.dev URL from runner-sandbox-host deploy output");
  }

  return url;
}

async function setCloudflareWorkerAuthSecret(token: string): Promise<void> {
  console.log("[storage:smoke:execute-flow] updating runner-sandbox-host AUTH_TOKEN secret...");
  await $`printf "%s" ${token} | bun run --cwd packages/runner-sandbox-host wrangler secret put AUTH_TOKEN`
    .cwd(EXECUTOR_ROOT)
    .env(process.env)
    .quiet(false);
}

async function maybeDeployConvex(enabled: boolean): Promise<void> {
  if (!enabled) {
    return;
  }

  console.log("[storage:smoke:execute-flow] deploying Convex functions...");
  await $`bunx --package convex convex dev --once --typecheck disable`
    .cwd(DATABASE_ROOT)
    .env(process.env)
    .quiet(false);
}

async function setConvexEnvVar(key: string, value: string): Promise<void> {
  await $`bunx --package convex convex env set ${key} ${value}`
    .cwd(DATABASE_ROOT)
    .env(process.env)
    .quiet(false);
}

async function waitForSourceReady(args: {
  client: ConvexHttpClient;
  workspaceId: string;
  sessionId: string;
  sourceName: string;
  timeoutMs: number;
}): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < args.timeoutMs) {
    const progress = await args.client.query(api.workspace.getToolInventoryProgress, {
      workspaceId: args.workspaceId as never,
      sessionId: args.sessionId,
    }) as {
      inventoryStatus?: { state?: string; error?: string };
      sourceStates?: Record<string, { state?: string; toolCount?: number }>;
      warnings?: string[];
    };

    const source = progress.sourceStates?.[args.sourceName];
    const inventoryState = progress.inventoryStatus?.state ?? "unknown";
    const sourceState = source?.state ?? "unknown";
    const sourceCount = source?.toolCount ?? 0;

    if (inventoryState === "failed") {
      throw new Error(
        `Tool inventory failed for source '${args.sourceName}': ${progress.inventoryStatus?.error ?? "unknown error"}`,
      );
    }

    if (sourceState === "ready" && sourceCount > 0) {
      return;
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out waiting for source '${args.sourceName}' to become ready`);
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const convexUrl = requireEnv("CONVEX_URL");
  const client = makeClient(convexUrl);

  const requestedRuntime: RuntimeId = options.runtimeId
    ?? (process.env.CLOUDFLARE_SANDBOX_RUN_URL?.trim() ? "cloudflare-worker-loader" : "local-bun");

  if (requestedRuntime === "local-bun" && isHostedConvexUrl(convexUrl)) {
    throw new Error(
      "local-bun storage smoke is self-host only. Hosted Convex deployments must use AGENT_STORAGE_PROVIDER=agentfs-cloudflare and the cloudflare-worker-loader runtime.",
    );
  }

  await maybeDeployConvex(options.deployConvex);

  if (requestedRuntime === "cloudflare-worker-loader") {
    let sandboxRunUrl = process.env.CLOUDFLARE_SANDBOX_RUN_URL?.trim();
    let sandboxAuthToken = process.env.CLOUDFLARE_SANDBOX_AUTH_TOKEN?.trim();

    if (!sandboxAuthToken || options.deployWorker) {
      sandboxAuthToken = `smoke_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
      await setCloudflareWorkerAuthSecret(sandboxAuthToken);
    }

    if (!sandboxRunUrl || options.deployWorker) {
      const workerUrl = await deployCloudflareWorkerAndGetUrl();
      sandboxRunUrl = `${workerUrl}/v1/runs`;
    }

    if (!sandboxRunUrl || !sandboxAuthToken) {
      throw new Error("Unable to resolve Cloudflare sandbox URL/token");
    }

    process.env.CLOUDFLARE_SANDBOX_RUN_URL = sandboxRunUrl;
    process.env.CLOUDFLARE_SANDBOX_AUTH_TOKEN = sandboxAuthToken;
    process.env.AGENT_STORAGE_PROVIDER = "agentfs-cloudflare";

    console.log("[storage:smoke:execute-flow] syncing Convex dev env vars for Cloudflare runtime/storage...");
    await setConvexEnvVar("CLOUDFLARE_SANDBOX_RUN_URL", sandboxRunUrl);
    await setConvexEnvVar("CLOUDFLARE_SANDBOX_AUTH_TOKEN", sandboxAuthToken);
    await setConvexEnvVar("AGENT_STORAGE_PROVIDER", "agentfs-cloudflare");
  } else {
    process.env.AGENT_STORAGE_PROVIDER = "agentfs-local";
    console.log("[storage:smoke:execute-flow] syncing Convex dev env vars for local storage backend...");
    await setConvexEnvVar("AGENT_STORAGE_PROVIDER", "agentfs-local");
  }

  const runId = crypto.randomUUID().slice(0, 8);
  const sessionId = `mcp_storage_e2e_${runId}`;
  const organizationName = `Storage Smoke Org ${runId}`;
  const sourceName = `storage-smoke-source-${runId}`;

  const bootstrap = await client.mutation(api.workspace.bootstrapAnonymousSession, {
    sessionId,
  }) as {
    sessionId: string;
    accountId: string;
    workspaceId: string;
  };

  assert.ok(bootstrap.sessionId, "bootstrap must return a sessionId");

  const createdOrg = await client.mutation(api.organizations.create, {
    sessionId: bootstrap.sessionId,
    name: organizationName,
  }) as {
    organization: { id: string; name: string };
    workspace: { id: string; name: string };
  };

  const workspaceId = createdOrg.workspace.id;
  assert.ok(workspaceId, "organization.create must return a workspace id");

  const openapiSpec = {
    openapi: "3.1.0",
    info: {
      title: `Storage Smoke API ${runId}`,
      version: "1.0.0",
    },
    servers: [
      { url: "https://example.com" },
    ],
    paths: {
      "/ping": {
        get: {
          operationId: "smoke_ping",
          summary: "Ping endpoint",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      ok: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const source = await client.action(api.workspace.upsertToolSource, {
    workspaceId: workspaceId as never,
    sessionId: bootstrap.sessionId,
    name: sourceName,
    type: "openapi",
    scopeType: "workspace",
    config: {
      spec: openapiSpec,
    },
  }) as { id: string; name: string };

  assert.equal(source.name, sourceName, "upsertToolSource should return created source");

  await client.mutation(api.workspace.regenerateToolInventory, {
    workspaceId: workspaceId as never,
    sessionId: bootstrap.sessionId,
  });

  await waitForSourceReady({
    client,
    workspaceId,
    sessionId: bootstrap.sessionId,
    sourceName,
    timeoutMs: options.timeoutMs,
  });

  const sourceNameLiteral = JSON.stringify(sourceName);
  const taskCode = [
    `const sourceName = ${sourceNameLiteral};`,
    "const storage = await tools.storage.open({ scopeType: 'scratch', purpose: 'execute-flow-smoke' });",
    "const instanceId = storage.instance.id;",
    "await tools.fs.mkdir({ instanceId, path: '/workspace' });",
    "await tools.fs.write({ instanceId, path: '/workspace/hello.txt', content: 'hello storage execute flow' });",
    "const file = await tools.fs.read({ instanceId, path: '/workspace/hello.txt' });",
    "await tools.kv.set({ instanceId, key: 'discord.userId', value: 'uuid-smoke' });",
    "const kv = await tools.kv.get({ instanceId, key: 'discord.userId' });",
    "await tools.sqlite.query({ instanceId, mode: 'write', sql: 'CREATE TABLE IF NOT EXISTS smoke (k TEXT PRIMARY KEY, v TEXT)' });",
    "await tools.sqlite.query({ instanceId, mode: 'write', sql: 'INSERT INTO smoke (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', params: ['discord', 'uuid-smoke'] });",
    "const sql = await tools.sqlite.query({ instanceId, mode: 'read', sql: 'SELECT v FROM smoke WHERE k = ?', params: ['discord'], maxRows: 1 });",
    "return {",
    "  instanceId,",
    "  provider: storage.instance.provider,",
    "  fileContent: file.content,",
    "  kvValue: kv.value,",
    "  sqlValue: Array.isArray(sql.rows) && sql.rows.length > 0 ? sql.rows[0].v : null,",
    "};",
  ].join("\n");

  const taskOutcome = await client.action(api.executor.createTask, {
    workspaceId: workspaceId as never,
    sessionId: bootstrap.sessionId,
    runtimeId: requestedRuntime,
    waitForResult: true,
    timeoutMs: Math.max(90_000, options.timeoutMs),
    code: taskCode,
    metadata: {
      purpose: "storage-execute-flow-smoke",
      runId,
    },
  }) as {
    task: { id: string; status: string; error?: string };
    result?: {
      instanceId?: string;
      provider?: string;
      fileContent?: string;
      kvValue?: string;
      sqlValue?: string | null;
    };
  };

  if (taskOutcome.task.status !== "completed") {
    throw new Error(`Task did not complete successfully: ${taskOutcome.task.status} ${taskOutcome.task.error ?? ""}`);
  }

  const result = taskOutcome.result ?? {};
  assert.equal(result.fileContent, "hello storage execute flow");
  assert.equal(result.kvValue, "uuid-smoke");
  assert.equal(result.sqlValue, "uuid-smoke");
  assert.ok(result.instanceId, "task result must include storage instanceId");

  const storageInstances = await client.query(api.workspace.listStorageInstances, {
    workspaceId: workspaceId as never,
    sessionId: bootstrap.sessionId,
    scopeType: "scratch",
  }) as Array<{ id: string; provider: string; status: string }>;

  const createdInstance = storageInstances.find((item) => item.id === result.instanceId);
  assert.ok(createdInstance, "workspace.listStorageInstances should include created scratch instance");

  if (result.instanceId) {
    await client.mutation(api.workspace.deleteStorageInstance, {
      workspaceId: workspaceId as never,
      sessionId: bootstrap.sessionId,
      instanceId: result.instanceId,
    });
  }

  console.log("[storage:smoke:execute-flow] PASS");
  console.log(`runtime=${requestedRuntime}`);
  console.log(`organization=${createdOrg.organization.id}`);
  console.log(`workspace=${workspaceId}`);
  console.log(`source=${source.id}`);
  console.log(`instance=${result.instanceId}`);
  console.log(`provider=${createdInstance?.provider ?? result.provider ?? "unknown"}`);
}

await run();

#!/usr/bin/env bun

import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../packages/database/convex/_generated/api";

type RuntimeId = "local-bun" | "cloudflare-worker-loader";

function requireConvexUrl(): string {
  const value = process.env.CONVEX_URL ?? process.env.CONVEX_SITE_URL;
  if (!value) {
    throw new Error("Missing CONVEX_URL or CONVEX_SITE_URL");
  }

  return value;
}

function buildProbeCode(): string {
  return [
    "const out = {};",
    "const summarize = (value) => {",
    "  if (value === undefined) return { type: 'undefined' };",
    "  if (value === null) return { type: 'null' };",
    "  const t = typeof value;",
    "  if (t === 'string') return { type: 'string', length: value.length, prefix: value.slice(0, 8) };",
    "  if (t === 'number' || t === 'boolean' || t === 'bigint') return { type: t, value };",
    "  if (t === 'function') return { type: 'function', name: value.name || '<anonymous>' };",
    "  if (t === 'object') {",
    "    try { return { type: 'object', keys: Object.keys(value).slice(0, 30) }; } catch { return { type: 'object' }; }",
    "  }",
    "  return { type: t };",
    "};",
    "const tokenKeys = ['CLOUDFLARE_SANDBOX_AUTH_TOKEN', 'EXECUTOR_INTERNAL_TOKEN', 'AUTH_TOKEN', 'CLOUDFLARE_SANDBOX_RUN_URL', 'CONVEX_URL'];",
    "let g;",
    "try { g = Function('return globalThis')(); } catch (error) { out.globalThisError = String(error); }",
    "out.globalThis = summarize(g);",
    "out.globalKeys = g ? Object.getOwnPropertyNames(g).slice(0, 80) : [];",
    "let processRef;",
    "try { processRef = Function(\"return typeof process !== 'undefined' ? process : undefined\")(); } catch (error) { out.processEvalError = String(error); }",
    "out.process = summarize(processRef);",
    "out.processEnv = summarize(processRef?.env);",
    "const processEnvProbe = {};",
    "for (const key of tokenKeys) {",
    "  let value;",
    "  try { value = processRef?.env?.[key]; } catch (error) { value = `<error:${String(error)}>`; }",
    "  processEnvProbe[key] = summarize(value);",
    "}",
    "out.processEnvProbe = processEnvProbe;",
    "let bunRef;",
    "try { bunRef = Function(\"return typeof Bun !== 'undefined' ? Bun : undefined\")(); } catch (error) { out.bunEvalError = String(error); }",
    "out.Bun = summarize(bunRef);",
    "let denoRef;",
    "try { denoRef = Function(\"return typeof Deno !== 'undefined' ? Deno : undefined\")(); } catch (error) { out.denoEvalError = String(error); }",
    "out.Deno = summarize(denoRef);",
    "try {",
    "  const src = tools.discover?.toString?.() ?? '<missing>';",
    "  out.discoverToString = src.slice(0, 220);",
    "} catch (error) {",
    "  out.discoverToStringError = String(error);",
    "}",
    "return out;",
  ].join("\n");
}

function extractSuspiciousKeys(result: unknown): string[] {
  const rec = (result && typeof result === "object") ? result as Record<string, unknown> : {};
  const probe = (rec.processEnvProbe && typeof rec.processEnvProbe === "object")
    ? rec.processEnvProbe as Record<string, unknown>
    : {};

  const leaked: string[] = [];
  for (const [key, value] of Object.entries(probe)) {
    const summary = (value && typeof value === "object") ? value as Record<string, unknown> : {};
    const type = summary.type;
    const length = summary.length;
    if (type === "string" && typeof length === "number" && length > 0) {
      leaked.push(key);
    }
  }

  return leaked;
}

async function runForRuntime(
  client: ConvexHttpClient,
  workspaceId: string,
  sessionId: string,
  runtimeId: RuntimeId,
  code: string,
) {
  const response = await client.action(api.executor.createTask, {
    workspaceId: workspaceId as never,
    sessionId,
    runtimeId,
    waitForResult: true,
    timeoutMs: 120_000,
    code,
    metadata: {
      purpose: "security-token-probe",
      runtimeId,
    },
  }) as {
    task: { id: string; status: string; error?: string };
    result?: unknown;
  };

  return response;
}

async function main() {
  const client = new ConvexHttpClient(requireConvexUrl(), {
    skipConvexDeploymentUrlCheck: true,
  });

  const sessionId = `mcp_token_probe_${crypto.randomUUID().slice(0, 8)}`;
  const bootstrap = await client.mutation(api.workspace.bootstrapAnonymousSession, { sessionId }) as {
    sessionId: string;
  };
  const created = await client.mutation(api.organizations.create, {
    sessionId: bootstrap.sessionId,
    name: `Token Probe Org ${crypto.randomUUID().slice(0, 8)}`,
  }) as {
    workspace: { id: string };
  };
  const workspaceId = created.workspace.id;
  const code = buildProbeCode();

  for (const runtimeId of ["local-bun", "cloudflare-worker-loader"] as const) {
    try {
      const response = await runForRuntime(client, workspaceId, sessionId, runtimeId, code);
      const leaked = extractSuspiciousKeys(response.result);

      console.log(`\n=== ${runtimeId} ===`);
      console.log(`taskStatus=${response.task.status}`);
      if (response.task.error) {
        console.log(`taskError=${response.task.error}`);
      }
      console.log(`leakedKeys=${leaked.length > 0 ? leaked.join(",") : "none"}`);
      console.log(JSON.stringify(response.result ?? null, null, 2));
    } catch (error) {
      console.log(`\n=== ${runtimeId} FAILED ===`);
      console.log(error instanceof Error ? error.message : String(error));
    }
  }
}

await main();

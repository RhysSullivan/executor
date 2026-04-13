import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command, Options, Args } from "@effect/cli";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { BunFileSystem } from "@effect/platform-bun";
import {
  findAndReadAgentConfig,
  detectInstalledAgents,
} from "@executor/plugin-mcp/agent-import";
import type { AgentKey, NormalizedServer } from "@executor/plugin-mcp/agent-import";
import { addSourceToConfig } from "@executor/config";
import type { SourceConfig } from "@executor/config";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const agentArg = Args.text({ name: "agent" }).pipe(Args.optional);

const fileOption = Options.text("file").pipe(
  Options.withDescription("Path to a config file to import"),
  Options.optional,
);

const dryRunOption = Options.boolean("dry-run").pipe(
  Options.withDescription("Preview servers without importing"),
  Options.withDefault(false),
);

const baseUrlOption = Options.text("base-url").pipe(Options.withDefault("http://localhost:4788"));

// ---------------------------------------------------------------------------
// API helpers (raw fetch — avoids typed client dep for new endpoints)
// ---------------------------------------------------------------------------

interface ImportedServer {
  namespace: string;
  name: string;
  toolCount: number;
}

interface SkippedServer {
  name: string;
  reason: string;
}

interface ImportResult {
  imported: ImportedServer[];
  skipped: SkippedServer[];
  dryRunParsed?: unknown[];
}

interface NormalizedServerPreview {
  name: string;
  suggestedNamespace: string;
  config: { transport: string; command?: string; endpoint?: string };
}

const apiGet = async <T>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
};

const apiPost = async <T>(url: string, body: unknown): Promise<T> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
};

const getScopeId = async (baseUrl: string): Promise<string> => {
  const data = await apiGet<{ id?: string }>(`${baseUrl}/api/scope`);
  return data.id ?? "default";
};

// ---------------------------------------------------------------------------
// Print helpers
// ---------------------------------------------------------------------------

const printResult = (filename: string, result: ImportResult) => {
  console.log(`\n${filename}:`);
  for (const s of result.imported) {
    console.log(`  ✓ ${s.name.padEnd(24)} →  ${s.namespace}  (${s.toolCount} tools)`);
  }
  for (const s of result.skipped) {
    console.log(`  ✗ ${s.name.padEnd(24)} skipped: ${s.reason}`);
  }
  console.log(`  ${result.imported.length} imported, ${result.skipped.length} skipped`);
};

const printDryRun = (filename: string, servers: NormalizedServerPreview[]) => {
  console.log(`\n${filename} — ${servers.length} server(s) found (dry run, not imported):`);
  for (const s of servers) {
    const detail = s.config.transport === "stdio" ? s.config.command : s.config.endpoint;
    console.log(`  ${s.name.padEnd(24)} [${s.config.transport}]  ${detail ?? ""}`);
  }
};

const printLocalDryRun = (filePath: string, servers: NormalizedServer[]) => {
  const filename = filePath.split(/[\\/]/).pop() ?? filePath;
  console.log(`\n${filename} — ${servers.length} server(s) found (dry run, not imported):`);
  console.log(`  ${filePath}`);
  for (const s of servers) {
    const detail =
      s.config.transport === "stdio" ? s.config.command : s.config.endpoint;
    console.log(`  ${s.name.padEnd(24)} [${s.config.transport}]  ${detail ?? ""}`);
  }
};

// ---------------------------------------------------------------------------
// Offline write — direct executor.jsonc update, no server required
// ---------------------------------------------------------------------------

const resolveConfigPath = (): string =>
  join(process.env.EXECUTOR_SCOPE_DIR ?? process.cwd(), "executor.jsonc");

const normalizedServerToSourceConfig = (server: NormalizedServer): SourceConfig => {
  if (server.config.transport === "stdio") {
    return {
      kind: "mcp",
      transport: "stdio",
      name: server.name,
      command: server.config.command,
      args: server.config.args ? [...server.config.args] : undefined,
      env: server.config.env,
      cwd: server.config.cwd,
      namespace: server.suggestedNamespace,
    };
  }
  return {
    kind: "mcp",
    transport: "remote",
    name: server.name,
    endpoint: server.config.endpoint,
    remoteTransport: server.config.remoteTransport,
    headers: server.config.headers,
    namespace: server.suggestedNamespace,
  };
};

const writeServersToConfigFile = (servers: NormalizedServer[]) =>
  Effect.gen(function* () {
    const configPath = resolveConfigPath();
    let written = 0;
    for (const server of servers) {
      const source = normalizedServerToSourceConfig(server);
      yield* addSourceToConfig(configPath, source).pipe(Effect.provide(BunFileSystem.layer));
      written++;
    }
    return { written, configPath };
  });

// Try server; if unreachable fall back to writing executor.jsonc directly
const importServersWithFallback = (
  servers: NormalizedServer[],
  filePath: string,
  agentKey: string | undefined,
  baseUrl: string,
) =>
  Effect.gen(function* () {
    const content = readFileSync(filePath, "utf-8");
    const filename = filePath.split(/[\\/]/).pop() ?? filePath;

    // Try server path
    const serverResult = yield* Effect.tryPromise({
      try: () => getScopeId(baseUrl),
      catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
    }).pipe(
      Effect.flatMap((scopeId) =>
        Effect.tryPromise({
          try: () =>
            apiPost<ImportResult>(`${baseUrl}/api/scopes/${scopeId}/mcp/import`, {
              content,
              filename,
              agentHint: agentKey,
              dryRun: false,
            }),
          catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
        }),
      ),
      Effect.map((r) => ({ ok: true as const, result: r })),
      Effect.catchAll(() => Effect.succeed({ ok: false as const })),
    );

    if (serverResult.ok) {
      printResult(filename, serverResult.result);
      return;
    }

    // Server not reachable — write to executor.jsonc offline
    const { written, configPath } = yield* writeServersToConfigFile(servers);
    console.log(`\n${filename}:`);
    console.log(`  ${written} server(s) written to ${configPath}`);
    console.log(`  (server offline — will load on next start)`);
  });

// ---------------------------------------------------------------------------
// Import a single file via API
// ---------------------------------------------------------------------------

const importFile = (
  content: string,
  filename: string,
  agentHint: string | undefined,
  baseUrl: string,
  dryRun: boolean,
) =>
  Effect.gen(function* () {
    const scopeId = yield* Effect.tryPromise({
      try: () => getScopeId(baseUrl),
      catch: (e) =>
        new Error(
          `Cannot reach executor at ${baseUrl}: ${e instanceof Error ? e.message : String(e)}`,
        ),
    });

    const result = yield* Effect.tryPromise({
      try: () =>
        apiPost<ImportResult>(`${baseUrl}/api/scopes/${scopeId}/mcp/import`, {
          content,
          filename,
          agentHint,
          dryRun,
        }),
      catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
    });

    if (dryRun && result.dryRunParsed) {
      printDryRun(filename, result.dryRunParsed as NormalizedServerPreview[]);
    } else {
      printResult(filename, result);
    }
  });

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const importCommand = Command.make(
  "import",
  {
    agent: agentArg,
    file: fileOption,
    dryRun: dryRunOption,
    baseUrl: baseUrlOption,
  },
  ({ agent, file, dryRun, baseUrl }) =>
    Effect.gen(function* () {
      const agentKey = Option.getOrUndefined(agent);
      const filePath = Option.getOrUndefined(file);

      // ---- --file path provided ----
      if (filePath) {
        const abs = resolve(filePath);
        if (!existsSync(abs)) {
          console.error(`File not found: ${abs}`);
          process.exitCode = 1;
          return;
        }
        const content = readFileSync(abs, "utf-8");
        const filename = abs.split(/[\\/]/).pop() ?? filePath;
        yield* importFile(content, filename, agentKey, baseUrl, dryRun);
        return;
      }

      // ---- agent name provided ----
      if (agentKey) {
        const resolved = yield* Effect.tryPromise({
          try: () => findAndReadAgentConfig(agentKey as AgentKey),
          catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
        });

        console.log(`Found: ${resolved.filePath}  (${resolved.servers.length} servers)`);

        if (dryRun) {
          printLocalDryRun(resolved.filePath, resolved.servers);
          return;
        }

        yield* importServersWithFallback(resolved.servers, resolved.filePath, agentKey, baseUrl);
        return;
      }

      // ---- auto-detect all agents ----
      console.log("Scanning for agent configs...\n");

      const detectedLocally = yield* Effect.tryPromise({
        try: () => detectInstalledAgents(),
        catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
      });

      if (detectedLocally.length === 0) {
        console.log("No agent configs found.");
        return;
      }

      console.log("Found:");
      for (let i = 0; i < detectedLocally.length; i++) {
        const d = detectedLocally[i]!;
        console.log(`  [${i + 1}] ${d.agent.padEnd(16)} ${d.filePath}  (${d.serverCount} servers)`);
      }

      if (dryRun) {
        console.log("\n(dry run — use without --dry-run to import)");
        return;
      }

      console.log("\nImporting all...");
      for (const d of detectedLocally) {
        if (!existsSync(d.filePath)) continue;
        const agentServers = yield* Effect.tryPromise({
          try: () => findAndReadAgentConfig(d.agent),
          catch: (e) => new Error(e instanceof Error ? e.message : String(e)),
        });
        yield* importServersWithFallback(agentServers.servers, d.filePath, d.agent, baseUrl);
      }
    }),
).pipe(
  Command.withDescription(
    "Import MCP servers from an AI agent config file.\n" +
      "Agents: opencode, claude-code, claude-desktop, amp, cursor, vscode, cline, cline-cli,\n" +
      "        zed, goose, codex, gemini-cli, copilot, antigravity, mcporter\n\n" +
      "Examples:\n" +
      "  executor import opencode\n" +
      "  executor import cursor --dry-run\n" +
      "  executor import --file ./opencode.json\n" +
      "  executor import  (auto-detect all)",
  ),
);

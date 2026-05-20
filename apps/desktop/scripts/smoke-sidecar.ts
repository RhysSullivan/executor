/**
 * End-to-end smoke test for the compiled sidecar binary.
 *
 * Catches "works in dev, breaks in --compile" regressions: bunfs asset
 * loading (QuickJS WASM, staged web UI), native
 * .node loaders (keychain), and the MCP → engine → QuickJS → tool path.
 *
 * Flow:
 *   1. Spin up a tiny local OpenAPI server (one operation, returns 42).
 *   2. Spawn the compiled `executor-sidecar` binary with EXECUTOR_PORT=0
 *      and parse the `EXECUTOR_READY:<port>` sentinel.
 *   3. Connect via MCP streamable HTTP, call the `execute` tool with code
 *      that registers and invokes the OpenAPI tool, assert the answer
 *      round-trips as 42.
 *
 * Run after `bun ./scripts/build-sidecar.ts`. Exits non-zero on any
 * deviation so it can gate CI.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn, type Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = resolve(import.meta.dir, "..");
const APPS_LOCAL_DRIZZLE = resolve(ROOT, "../local/drizzle");
const BINARY = resolve(
  ROOT,
  "resources/sidecar",
  process.platform === "win32" ? "executor-sidecar.exe" : "executor-sidecar",
);

const AUTH_PASSWORD = "smoke-test-password";
const AUTH_HEADER = `Basic ${btoa(`executor:${AUTH_PASSWORD}`)}`;
const READY_TIMEOUT_MS = 30_000;

const fail = (msg: string): never => {
  console.error(`[smoke-sidecar] FAIL: ${msg}`);
  process.exit(1);
};

type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const makeScopeId = (cwd: string): string => {
  const folder = basename(cwd) || cwd;
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${folder}-${hash}`;
};

const readLegacyMigrationHashes = async (): Promise<readonly string[]> => {
  const journal = (await Bun.file(join(APPS_LOCAL_DRIZZLE, "meta/_journal.json")).json()) as {
    readonly entries: readonly { readonly idx: number; readonly tag: string }[];
  };

  const hashes: string[] = [];
  for (const entry of [...journal.entries].sort((left, right) => left.idx - right.idx)) {
    const query = await Bun.file(join(APPS_LOCAL_DRIZZLE, `${entry.tag}.sql`)).text();
    hashes.push(createHash("sha256").update(query).digest("hex"));
  }
  return hashes;
};

const seedLegacyScopedSqlite = async (dataDir: string, scopeId: string): Promise<void> => {
  const db = new Database(join(dataDir, "data.db"));
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: standalone smoke harness closes the SQLite handle before spawning the sidecar
  try {
    db.exec(`
      CREATE TABLE source (
        scope_id TEXT NOT NULL,
        id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT,
        can_remove INTEGER NOT NULL,
        can_refresh INTEGER NOT NULL,
        can_edit INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope_id, id)
      );
      CREATE TABLE blob (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      );
      CREATE TABLE "__drizzle_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        hash text NOT NULL,
        created_at numeric
      );
    `);

    const insertMigration = db.prepare(
      `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)`,
    );
    for (const hash of await readLegacyMigrationHashes()) {
      insertMigration.run(hash, Date.now());
    }

    db.prepare(
      `INSERT INTO source (
        scope_id, id, plugin_id, kind, name, url, can_remove, can_refresh, can_edit, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      scopeId,
      "legacy-smoke",
      "smoke",
      "remote",
      "Legacy Smoke Source",
      null,
      1,
      0,
      1,
      1_700_000_000_000,
      1_700_000_001_000,
    );
    db.prepare("INSERT INTO blob (namespace, key, value) VALUES (?, ?, ?)").run(
      `${scopeId}/smoke`,
      "legacy",
      "{}",
    );
    db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
  } finally {
    db.close();
  }
};

const assertLegacyImportCompleted = async (dataDir: string): Promise<void> => {
  const markerPath = join(dataDir, "fumadb-sqlite-imported");
  if (!(await Bun.file(markerPath).exists())) {
    fail(`legacy SQLite import marker was not written at ${markerPath}`);
  }

  const marker = (await Bun.file(markerPath).json()) as {
    readonly importedRows?: number;
    readonly importedTables?: readonly string[];
    readonly backupPath?: string;
  };
  if ((marker.importedRows ?? 0) < 2 || !marker.importedTables?.includes("source")) {
    fail(`legacy SQLite import marker has unexpected contents: ${JSON.stringify(marker)}`);
  }
  if (!marker.backupPath || !(await Bun.file(marker.backupPath).exists())) {
    fail(`legacy SQLite backup was not preserved: ${JSON.stringify(marker)}`);
  }
};

// Petstore-style spec: GET list + GET by id. Exercises path params,
// multi-step orchestration, and array/object response shapes against a real
// running HTTP server, all the way through the compiled binary →
// MCP → QuickJS → openapi-invoker → HttpClient chain.
const startOpenApiServer = () => {
  const Pet = {
    type: "object",
    properties: {
      id: { type: "integer" },
      name: { type: "string" },
      tag: { type: "string" },
    },
    required: ["id", "name"],
  };

  const spec = {
    openapi: "3.0.0",
    info: { title: "Petstore Smoke API", version: "0.0.1" },
    paths: {
      "/pets": {
        get: {
          operationId: "listPets",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { type: "array", items: Pet } },
              },
            },
          },
        },
      },
      "/pets/{petId}": {
        get: {
          operationId: "getPet",
          parameters: [
            {
              name: "petId",
              in: "path",
              required: true,
              schema: { type: "integer" },
            },
          ],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: Pet } },
            },
            "404": { description: "not found" },
          },
        },
      },
    },
  };

  // Seed the in-memory store so the GET-driven smoke can verify list +
  // path-param round-trips. Body-bearing POST/PUT is gated by the
  // executor's approval flow and is covered by separate non-compiled tests.
  const pets: Array<{ id: number; name: string; tag?: string }> = [
    { id: 1, name: "Fido", tag: "dog" },
    { id: 2, name: "Whiskers", tag: "cat" },
  ];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/openapi.json") return Response.json(spec);

      if (url.pathname === "/pets" && req.method === "GET") {
        return Response.json(pets);
      }

      const match = /^\/pets\/(\d+)$/.exec(url.pathname);
      if (match && req.method === "GET") {
        const pet = pets.find((p) => p.id === Number(match[1]));
        if (!pet) return new Response("not found", { status: 404 });
        return Response.json(pet);
      }

      return new Response("not found", { status: 404 });
    },
  });
  return { server, origin: `http://127.0.0.1:${server.port}` };
};

const waitForReadyPort = (proc: Subprocess<"ignore", "pipe", "pipe">): Promise<number> =>
  // oxlint-disable-next-line executor/no-promise-reject -- boundary: standalone build-time smoke harness, no Effect runtime
  new Promise((resolveReady, rejectReady) => {
    const deadline = setTimeout(() => {
      // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: standalone smoke harness reporting a build-time timeout
      rejectReady(new Error(`sidecar did not announce ready within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);

    let stdoutBuf = "";
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();

    const stderrReader = proc.stderr.getReader();
    void (async () => {
      while (true) {
        const { value, done } = await stderrReader.read();
        if (done) return;
        process.stderr.write(`[sidecar-stderr] ${decoder.decode(value)}`);
      }
    })();

    void (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          clearTimeout(deadline);
          // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: standalone smoke harness, stdout-closed surfaced as rejection
          rejectReady(new Error("sidecar stdout closed before ready"));
          return;
        }
        const chunk = decoder.decode(value);
        process.stdout.write(`[sidecar-stdout] ${chunk}`);
        stdoutBuf += chunk;
        const match = /EXECUTOR_READY:(\d+)/.exec(stdoutBuf);
        if (match) {
          clearTimeout(deadline);
          resolveReady(parseInt(match[1]!, 10));
          return;
        }
      }
    })();
  });

const completePausedResult = async (
  client: Client,
  initial: ToolCallResult,
): Promise<Record<string, unknown>> => {
  let result = initial;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (result.isError) {
      fail(`tool returned isError: ${JSON.stringify(result.content)}`);
    }

    const structured = result.structuredContent;
    if (!isRecord(structured)) {
      fail(`tool returned no structured content: ${JSON.stringify(result.content)}`);
    }
    const structuredRecord = structured as Record<string, unknown>;

    if (structuredRecord.status !== "waiting_for_interaction") {
      return structuredRecord;
    }

    const executionId = structuredRecord.executionId;
    if (typeof executionId !== "string" || executionId.length === 0) {
      fail(`paused result missing executionId: ${JSON.stringify(structuredRecord)}`);
    }

    console.log(`[smoke-sidecar] auto-accepting paused execution ${executionId}`);
    result = await client.callTool({
      name: "resume",
      arguments: { executionId, action: "accept", content: "{}" },
    });
  }

  return fail("execute still paused after 5 resume attempts");
};

const main = async () => {
  if (!(await Bun.file(BINARY).exists())) {
    fail(
      `binary not found at ${BINARY}. Run \`bun ./scripts/build-sidecar.ts\` from apps/desktop first.`,
    );
  }

  const scopeDir = await mkdtemp(join(tmpdir(), "executor-smoke-scope-"));
  const dataDir = await mkdtemp(join(tmpdir(), "executor-smoke-data-"));
  await seedLegacyScopedSqlite(dataDir, makeScopeId(scopeDir));
  const openapi = startOpenApiServer();

  console.log(`[smoke-sidecar] scope:   ${scopeDir}`);
  console.log(`[smoke-sidecar] data:    ${dataDir}`);
  console.log(`[smoke-sidecar] openapi: ${openapi.origin}`);

  const proc = spawn({
    cmd: [BINARY],
    env: {
      ...process.env,
      EXECUTOR_PORT: "0",
      EXECUTOR_HOST: "127.0.0.1",
      EXECUTOR_AUTH_PASSWORD: AUTH_PASSWORD,
      EXECUTOR_SCOPE_DIR: scopeDir,
      EXECUTOR_DATA_DIR: dataDir,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let exitCode: number | null = null;
  void proc.exited.then((code) => {
    exitCode = code;
  });

  const cleanup = async () => {
    if (exitCode === null) {
      proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(3000)]);
      if (exitCode === null) proc.kill("SIGKILL");
    }
    openapi.server.stop(true);
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: best-effort tempdir cleanup in a standalone smoke harness
    await rm(scopeDir, { recursive: true, force: true }).catch(() => {});
    // oxlint-disable-next-line executor/no-promise-catch -- boundary: best-effort tempdir cleanup in a standalone smoke harness
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  };

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: standalone smoke harness needs a finally to tear down the spawned binary + http server
  try {
    const port = await waitForReadyPort(proc);
    await assertLegacyImportCompleted(dataDir);
    const mcpUrl = new URL(`http://127.0.0.1:${port}/mcp`);
    console.log(`[smoke-sidecar] ready on ${mcpUrl.origin}`);

    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: { headers: { Authorization: AUTH_HEADER } },
    });
    const client = new Client({ name: "smoke-test", version: "0.0.1" });
    await client.connect(transport);

    const tools = await client.listTools();
    const hasExecute = tools.tools.some((t) => t.name === "execute");
    if (!hasExecute) fail(`MCP tools/list missing "execute": ${JSON.stringify(tools.tools)}`);
    const hasResume = tools.tools.some((t) => t.name === "resume");
    if (!hasResume) fail(`MCP tools/list missing "resume": ${JSON.stringify(tools.tools)}`);

    // Drive the running OpenAPI server through a multi-step orchestration
    // in one execute. Covers: source registration, array list response, path
    // param dispatch, and object responses — all going out over real HTTP from
    // inside QuickJS.
    const code = `
const unwrapToolData = (value) => {
  if (value && typeof value === "object" && "ok" in value) {
    if (!value.ok) throw new Error(value.error?.message ?? "Tool failed");
    value = value.data;
  }
  if (value && typeof value === "object" && "data" in value) return value.data;
  return value;
};
await tools.executor.openapi.addSource({
  spec: { kind: "url", url: ${JSON.stringify(`${openapi.origin}/openapi.json`)} },
  name: "Petstore Smoke API",
  baseUrl: ${JSON.stringify(openapi.origin)},
  namespace: "petstore",
});
const listResult = await tools.petstore.pets.listPets({});
const list = unwrapToolData(listResult);
const fetched = await tools.petstore.pets.getPet({ petId: list[1].id });
const fetchedData = unwrapToolData(fetched);
return {
  count: list.length,
  names: list.map((p) => p.name),
  fetched: { id: fetchedData.id, name: fetchedData.name },
};
`;

    const result = await client.callTool({ name: "execute", arguments: { code } });
    const structured = await completePausedResult(client, result);
    const expected = {
      count: 2,
      names: ["Fido", "Whiskers"],
      fetched: { id: 2, name: "Whiskers" },
    };
    if (JSON.stringify(structured.result) !== JSON.stringify(expected)) {
      fail(
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(structured.result)} (content: ${JSON.stringify(result.content)})`,
      );
    }

    await client.close();
    console.log(
      `[smoke-sidecar] OK — listPets + getPet({petId:2}) round-tripped through the running OpenAPI server`,
    );
  } finally {
    await cleanup();
  }
};

await main();

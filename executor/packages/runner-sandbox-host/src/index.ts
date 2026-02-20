/**
 * Executor Sandbox Host Worker
 *
 * This Cloudflare Worker uses the Dynamic Worker Loader API to run
 * agent-generated code in sandboxed isolates. It exposes a single HTTP
 * endpoint (`POST /v1/runs`) that the executor's Convex action calls.
 *
 * ## How it works
 *
 * 1. Receives a run request with `{ taskId, code, timeoutMs, callback }`.
 *
 * 2. Uses `env.LOADER.get(id, () => WorkerCode)` to spawn a dynamic isolate
 *    containing the user's code.
 *
 * 3. The isolate's network access is fully blocked (`globalOutbound: null`).
 *    Instead, tool calls are routed through a `ToolBridge` entrypoint class
 *    (passed as a loopback service binding via `ctx.exports`) which invokes
 *    Convex callback RPC functions to resolve them.
 *
 * 4. Console output is intentionally discarded. Only explicit `return` values
 *    are included in terminal run results.
 *
 * 5. `/v1/runs` waits for execution to finish and returns the terminal result
 *    directly to the caller.
 *
 * ## Code isolation
 *
 * User code is placed in a **separate JS module** (`user-code.js`) that
 * exports a single `run(tools, console)` async function. The harness module
 * (`harness.js`) imports and calls this function, passing controlled `tools`
 * and `console` proxies. Because the user code is in a different module, it
 * cannot access the harness's `fetch` handler scope, `req`, `env`, `ctx`,
 * or `Response` — preventing IIFE escape attacks and response forgery.
 */

import { Result } from "better-result";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { AgentFS, type CloudflareStorage } from "agentfs-sdk/cloudflare";
import { encodeToolCallResultForTransport } from "../../core/src/tool-call-result-transport";
import GLOBALS_MODULE from "./isolate/globals.isolate.js";
import HARNESS_CODE from "./isolate/harness.isolate.js";
import { authorizeRunRequest } from "./auth";
import { callToolWithBridge, getBridgePropsFromContext } from "./bridge";
import { parseRunRequest } from "./request";
import { executeSandboxRun } from "./sandbox";
import type { Env, RunResult, StorageProxyRequest, ToolCallResult } from "./types";

const failedResult = (error: string): RunResult => ({
  status: "failed",
  error,
});

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function toStorageError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isReadOnlySql(sql: string): boolean {
  const trimmed = sql.trim().toLowerCase();
  return trimmed.startsWith("select")
    || trimmed.startsWith("pragma")
    || trimmed.startsWith("explain")
    || trimmed.startsWith("with");
}

function hasMultipleSqlStatements(sql: string): boolean {
  const statements = sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return statements.length > 1;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "NOT_FOUND";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

type StorageRequestPayload = {
  operation?: string;
  payload?: Record<string, unknown>;
};

export class AgentFSStorageObject extends DurableObject<Env> {
  private readonly fs: AgentFS;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.fs = AgentFS.create(ctx.storage as unknown as CloudflareStorage);
    this.ensureKvTable();
  }

  private ensureKvTable() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      )
    `);
  }

  private parseRequestPayload(body: unknown): StorageRequestPayload {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {};
    }
    const record = body as Record<string, unknown>;
    return {
      operation: typeof record.operation === "string" ? record.operation : undefined,
      payload: record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
        ? record.payload as Record<string, unknown>
        : {},
    };
  }

  private sqliteQuery(sql: string, params: unknown[], mode: "read" | "write", maxRows: number) {
    if (mode === "read" && !isReadOnlySql(sql)) {
      throw new Error("sqlite.query rejected a non-read SQL statement in read mode");
    }

    if (hasMultipleSqlStatements(sql)) {
      throw new Error("sqlite.query rejects multi-statement SQL payloads");
    }

    if (mode === "read") {
      this.ctx.storage.sql.exec("PRAGMA query_only = 1");
      try {
        const cursor = this.ctx.storage.sql.exec(sql, ...params);
        const rows = cursor.toArray().slice(0, Math.max(1, Math.floor(maxRows))) as Record<string, unknown>[];
        return {
          mode,
          rows,
          rowCount: rows.length,
        };
      } finally {
        this.ctx.storage.sql.exec("PRAGMA query_only = 0");
      }
    }

    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    if (mode === "write") {
      return {
        mode,
        rowCount: 0,
        changes: cursor.rowsWritten,
      };
    }

    return {
      mode,
      rows: [],
      rowCount: 0,
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    const body = await request.json().catch(() => null);
    const parsed = this.parseRequestPayload(body);
    const operation = parsed.operation?.trim();
    const payload = parsed.payload ?? {};

    if (!operation) {
      return jsonResponse({ ok: false, error: "Missing operation" }, 400);
    }

    try {
      if (operation === "fs.read") {
        const path = typeof payload.path === "string" ? payload.path : "";
        if (!path) {
          return jsonResponse({ ok: false, error: "fs.read requires path" }, 400);
        }
        const encoding = payload.encoding === "base64" ? "base64" : "utf8";
        if (encoding === "base64") {
          const buffer = await this.fs.readFile(path);
          return jsonResponse({ ok: true, data: { content: bytesToBase64(buffer), bytes: buffer.length } });
        }

        const content = await this.fs.readFile(path, "utf8");
        return jsonResponse({ ok: true, data: { content, bytes: new TextEncoder().encode(content).length } });
      }

      if (operation === "fs.write") {
        const path = typeof payload.path === "string" ? payload.path : "";
        const content = typeof payload.content === "string" ? payload.content : "";
        if (!path) {
          return jsonResponse({ ok: false, error: "fs.write requires path" }, 400);
        }
        const encoding = payload.encoding === "base64" ? "base64" : "utf8";
        const bytesWritten = encoding === "base64"
          ? base64ToBytes(content).length
          : new TextEncoder().encode(content).length;
        if (encoding === "base64") {
          await this.fs.writeFile(path, base64ToBytes(content) as unknown as Buffer);
        } else {
          await this.fs.writeFile(path, content);
        }
        return jsonResponse({
          ok: true,
          data: {
            bytesWritten,
          },
        });
      }

      if (operation === "fs.readdir") {
        const path = typeof payload.path === "string" && payload.path.trim().length > 0 ? payload.path : "/";
        const entries = await this.fs.readdirPlus(path);
        return jsonResponse({
          ok: true,
          data: {
            entries: entries.map((entry) => ({
              name: entry.name,
              type: entry.stats.isDirectory()
                ? "directory"
                : entry.stats.isFile()
                  ? "file"
                  : entry.stats.isSymbolicLink()
                    ? "symlink"
                    : "unknown",
              size: entry.stats.size,
              mtime: entry.stats.mtime,
            })),
          },
        });
      }

      if (operation === "fs.stat") {
        const path = typeof payload.path === "string" ? payload.path : "";
        if (!path) {
          return jsonResponse({ ok: false, error: "fs.stat requires path" }, 400);
        }

        try {
          const stat = await this.fs.stat(path);
          return jsonResponse({
            ok: true,
            data: {
              exists: true,
              type: stat.isDirectory()
                ? "directory"
                : stat.isFile()
                  ? "file"
                  : stat.isSymbolicLink()
                    ? "symlink"
                    : "unknown",
              size: stat.size,
              mode: stat.mode,
              mtime: stat.mtime,
              ctime: stat.ctime,
            },
          });
        } catch (error) {
          if (isNotFoundError(error)) {
            return jsonResponse({ ok: true, data: { exists: false } });
          }
          throw error;
        }
      }

      if (operation === "fs.mkdir") {
        const path = typeof payload.path === "string" ? payload.path : "";
        if (!path) {
          return jsonResponse({ ok: false, error: "fs.mkdir requires path" }, 400);
        }

        await this.fs.mkdir(path);
        return jsonResponse({ ok: true, data: { ok: true } });
      }

      if (operation === "fs.remove") {
        const path = typeof payload.path === "string" ? payload.path : "";
        if (!path) {
          return jsonResponse({ ok: false, error: "fs.remove requires path" }, 400);
        }

        await this.fs.rm(path, {
          recursive: payload.recursive === true,
          force: payload.force === true,
        });
        return jsonResponse({ ok: true, data: { ok: true } });
      }

      if (operation === "kv.get") {
        const key = typeof payload.key === "string" ? payload.key : "";
        if (!key) {
          return jsonResponse({ ok: false, error: "kv.get requires key" }, 400);
        }

        this.ensureKvTable();
        const row = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM kv_store WHERE key = ?", key).one();
        if (!row || typeof row.value !== "string") {
          return jsonResponse({ ok: true, data: { value: undefined } });
        }
        return jsonResponse({ ok: true, data: { value: JSON.parse(row.value) } });
      }

      if (operation === "kv.set") {
        const key = typeof payload.key === "string" ? payload.key : "";
        if (!key) {
          return jsonResponse({ ok: false, error: "kv.set requires key" }, 400);
        }

        this.ensureKvTable();
        this.ctx.storage.sql.exec(
          `
            INSERT INTO kv_store (key, value, updated_at)
            VALUES (?, ?, unixepoch())
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
          `,
          key,
          JSON.stringify(payload.value),
        );
        return jsonResponse({ ok: true, data: { ok: true } });
      }

      if (operation === "kv.list") {
        this.ensureKvTable();
        const prefix = typeof payload.prefix === "string" ? payload.prefix : "";
        const limit = typeof payload.limit === "number" && Number.isFinite(payload.limit)
          ? Math.max(1, Math.min(500, Math.floor(payload.limit)))
          : 100;
        const escaped = prefix
          .replaceAll("^", "^^")
          .replaceAll("%", "^%")
          .replaceAll("_", "^_");
        const rows = this.ctx.storage.sql
          .exec<{ key: string; value: string }>(
            "SELECT key, value FROM kv_store WHERE key LIKE ? ESCAPE '^' ORDER BY key LIMIT ?",
            `${escaped}%`,
            limit,
          )
          .toArray();

        return jsonResponse({
          ok: true,
          data: {
            items: rows.map((row) => ({
              key: row.key,
              value: JSON.parse(row.value),
            })),
          },
        });
      }

      if (operation === "kv.delete") {
        const key = typeof payload.key === "string" ? payload.key : "";
        if (!key) {
          return jsonResponse({ ok: false, error: "kv.delete requires key" }, 400);
        }

        this.ensureKvTable();
        this.ctx.storage.sql.exec("DELETE FROM kv_store WHERE key = ?", key);
        return jsonResponse({ ok: true, data: { ok: true } });
      }

      if (operation === "sqlite.query") {
        const sql = typeof payload.sql === "string" ? payload.sql : "";
        if (!sql) {
          return jsonResponse({ ok: false, error: "sqlite.query requires sql" }, 400);
        }

        const mode = payload.mode === "write" ? "write" : "read";
        const params = Array.isArray(payload.params)
          ? payload.params.filter((value) =>
            value === null
            || typeof value === "string"
            || typeof value === "number"
            || typeof value === "boolean"
          ).map((value) => (typeof value === "boolean" ? (value ? 1 : 0) : value))
          : [];
        const maxRows = typeof payload.maxRows === "number" && Number.isFinite(payload.maxRows)
          ? Math.max(1, Math.min(1000, Math.floor(payload.maxRows)))
          : 200;

        const result = this.sqliteQuery(sql, params, mode, maxRows);
        return jsonResponse({ ok: true, data: result });
      }

      if (operation === "instance.usage") {
        const stats = await this.fs.statfs();
        return jsonResponse({
          ok: true,
          data: {
            sizeBytes: stats.bytesUsed,
            fileCount: stats.inodes,
          },
        });
      }

      if (operation === "instance.delete") {
        const storageWithDelete = this.ctx.storage as unknown as { deleteAll?: () => Promise<void> | void };
        if (typeof storageWithDelete.deleteAll === "function") {
          await storageWithDelete.deleteAll();
        }
        return jsonResponse({ ok: true, data: { ok: true } });
      }

      return jsonResponse({ ok: false, error: `Unsupported storage operation: ${operation}` }, 400);
    } catch (error) {
      return jsonResponse({ ok: false, error: toStorageError(error) }, 500);
    }
  }
}

// ── Tool Bridge Entrypoint ───────────────────────────────────────────────────
//
// This class is exposed as a named entrypoint on the host Worker. A loopback
// service binding (via `ctx.exports.ToolBridge({props: ...})`) is passed into
// the dynamic isolate's `env`. When the isolate calls
// `env.TOOL_BRIDGE.callTool(...)`, the RPC call lands here.
//
// `this.ctx.props` carries the callback URL and auth token for the specific task.

export class ToolBridge extends WorkerEntrypoint<Env> {
  private get props() {
    return getBridgePropsFromContext(this.ctx);
  }

  /** Forward a tool call to the Convex callback RPC action. */
  async callTool(toolPath: string, input: unknown, callId?: string): Promise<string> {
    const result = await callToolWithBridge(this.props, toolPath, input, callId);
    return encodeToolCallResultForTransport(result as ToolCallResult);
  }
}

// ── Main Handler ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/v1/storage") {
      const authError = authorizeRunRequest(request, env.AUTH_TOKEN);
      if (authError) {
        return authError;
      }

      const parsed = await request.json().catch(() => null) as StorageProxyRequest | null;
      const instanceId = parsed?.instanceId?.trim() ?? "";
      const operation = parsed?.operation?.trim() ?? "";
      if (!instanceId || !operation) {
        return jsonResponse({ ok: false, error: "instanceId and operation are required" }, 400);
      }

      const objectId = env.AGENTFS.idFromName(instanceId);
      const stub = env.AGENTFS.get(objectId);
      return await stub.fetch("https://agentfs.internal/ops", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operation,
          payload: parsed?.payload ?? {},
        }),
      });
    }

    if (request.method !== "POST" || url.pathname !== "/v1/runs") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const authError = authorizeRunRequest(request, env.AUTH_TOKEN);
    if (authError) {
      return authError;
    }

    const parsed = await parseRunRequest(request);
    if (parsed instanceof Response) {
      return parsed;
    }

    const runResult = await Result.tryPromise(() => executeSandboxRun(parsed, ctx, env, HARNESS_CODE, GLOBALS_MODULE));
    const finalResult = runResult.isOk()
      ? runResult.value
      : failedResult(
          `Sandbox host error: ${runResult.error.cause instanceof Error
            ? runResult.error.cause.message
            : String(runResult.error.cause)}`,
        );

    return Response.json(finalResult, { status: 200 });
  },
};

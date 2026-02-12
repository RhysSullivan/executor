#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDb,
  queryCollections,
  rowCount,
  triggerSync,
  type SyncState,
  type SyncConfig,
} from "./scraper";

// ---------------------------------------------------------------------------
// Config (env with defaults)
// ---------------------------------------------------------------------------

const PORT = Math.max(1, Math.min(65535, Number(process.env.SOURCES_PORT) || 4343));
const DB_PATH = process.env.SOURCES_DB_PATH ?? fileURLToPath(new URL("./data/catalog.sqlite", import.meta.url));
const SYNC_INTERVAL_MS = Math.max(60_000, Number(process.env.SOURCES_SYNC_INTERVAL_MS) || 6 * 60 * 60 * 1000);
const LIST_URL = process.env.SOURCES_LIST_URL ?? "https://api.apis.guru/v2/list.json";
const ALLOWED_ORIGINS = process.env.SOURCES_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseInteger(input: string | null, fallback: number): number {
  if (!input) return fallback;
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function parseSort(value: string | null): "popular" | "recent" {
  return value === "recent" ? "recent" : "popular";
}

function json(data: unknown, status = 200, corsHeaders?: Record<string, string>): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", ...corsHeaders },
  });
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  // In dev, allow any localhost origin. In prod, check allowlist.
  const allowed =
    origin.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/) ||
    ALLOWED_ORIGINS.includes(origin);

  if (!allowed && origin) return {};

  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

await mkdir(dirname(DB_PATH), { recursive: true });
const db = createDb(DB_PATH);
const syncConfig: SyncConfig = { listUrl: LIST_URL };
const state: SyncState = {
  inFlight: null,
  lastSyncedAt: null,
  lastError: null,
  lastCount: rowCount(db),
};

// ---------------------------------------------------------------------------
// CLI: --sync-only
// ---------------------------------------------------------------------------

if (Bun.argv.includes("--sync-only")) {
  try {
    const result = await triggerSync(db, state, syncConfig, "cli");
    console.log(`synced ${result.count} sources into ${DB_PATH}`);
  } finally {
    db.close();
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  fetch: async (request) => {
    const cors = corsHeaders(request);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    // GET /health
    if (request.method === "GET" && url.pathname === "/health") {
      return json({
        ok: true,
        count: rowCount(db),
        lastSyncedAt: state.lastSyncedAt,
        lastError: state.lastError,
        lastCount: state.lastCount,
      }, 200, cors);
    }

    // POST|GET /admin/sync
    if ((request.method === "POST" || request.method === "GET") && url.pathname === "/admin/sync") {
      try {
        const result = await triggerSync(db, state, syncConfig, "manual");
        return json({ ok: true, ...result }, 200, cors);
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500, cors);
      }
    }

    // GET /collections
    if (request.method === "GET" && url.pathname === "/collections") {
      try {
        // Auto-seed on first request if DB is empty
        if (rowCount(db) === 0) {
          await triggerSync(db, state, syncConfig, "seed");
        }

        const q = url.searchParams.get("q")?.trim() ?? "";
        const sort = parseSort(url.searchParams.get("sort"));
        const limit = Math.max(1, Math.min(MAX_LIMIT, parseInteger(url.searchParams.get("limit"), DEFAULT_LIMIT)));
        const offset = Math.max(0, parseInteger(url.searchParams.get("offset"), 0));

        const result = queryCollections(db, { q, sort, limit, offset });
        return json({
          items: result.items,
          totalCount: result.totalCount,
          hasMore: result.hasMore,
          limit,
          offset,
        }, 200, cors);
      } catch (error) {
        return json({
          error: "Failed to load API catalog",
          detail: error instanceof Error ? error.message : String(error),
        }, 500, cors);
      }
    }

    return json({ error: "Not found" }, 404, cors);
  },
});

console.log(`[sources] running on http://127.0.0.1:${server.port}`);
console.log(`[sources] db: ${DB_PATH}`);
console.log(`[sources] endpoints: GET /collections, GET /health, POST /admin/sync`);

// Non-blocking startup sync
void triggerSync(db, state, syncConfig, "startup").catch((error) => {
  console.error(`[sources] initial sync failed: ${error instanceof Error ? error.message : String(error)}`);
});

// Periodic sync
const syncInterval = setInterval(() => {
  void triggerSync(db, state, syncConfig, "interval").catch((error) => {
    console.error(`[sources] scheduled sync failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}, SYNC_INTERVAL_MS);

// Graceful shutdown
let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(syncInterval);
  server.stop();
  db.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

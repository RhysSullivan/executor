import { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// List.json shape (from APIs.guru / our fork)
// ---------------------------------------------------------------------------

interface ListOrigin {
  format: string;
  url: string;
  version: string;
}

interface ListVersionInfo {
  contact?: { email?: string; name?: string; url?: string };
  description?: string;
  title?: string;
  version?: string;
  "x-apisguru-categories"?: string[];
  "x-logo"?: { url?: string };
  "x-origin"?: ListOrigin[];
  "x-providerName"?: string;
}

interface ListVersion {
  added?: string;
  updated?: string;
  info: ListVersionInfo;
  swaggerUrl: string;
  swaggerYamlUrl?: string;
  openapiVer?: string;
  link?: string;
}

interface ListEntry {
  added?: string;
  preferred: string;
  versions: Record<string, ListVersion>;
}

type ListJson = Record<string, ListEntry>;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface CatalogItem {
  id: string;
  name: string;
  summary: string;
  specUrl: string;
  originUrl: string;
  providerName: string;
  logoUrl: string;
  categories: string;
  version: string;
}

export interface SyncState {
  inFlight: Promise<SyncResult> | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  lastCount: number;
}

export interface SyncResult {
  count: number;
  syncedAt: number;
  trigger: string;
}

export interface SyncConfig {
  listUrl: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIST_URL = "https://api.apis.guru/v2/list.json";
const SUPPLEMENTS_PATH = fileURLToPath(new URL("./supplements.json", import.meta.url));

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function compactText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Mapping – list.json entry → DB row
// ---------------------------------------------------------------------------

interface ApiRow {
  id: string;
  name: string;
  summary: string;
  spec_url: string;
  origin_url: string;
  provider_name: string;
  logo_url: string;
  categories: string;
  version: string;
  updated_at: number;
  search_text: string;
  search_compact: string;
}

function mapEntry(providerKey: string, entry: ListEntry): ApiRow | null {
  const ver = entry.versions[entry.preferred];
  if (!ver) return null;

  const info = ver.info;
  const name = (info.title ?? providerKey).trim();
  if (!name) return null;

  const summary = (info.description ?? "").trim();
  const specUrl = ver.swaggerUrl;
  if (!specUrl) return null;

  const originUrl = info["x-origin"]?.[0]?.url ?? "";
  const providerName = (info["x-providerName"] ?? providerKey).trim();
  const logoUrl = info["x-logo"]?.url ?? "";
  const categories = (info["x-apisguru-categories"] ?? []).join(",");
  const version = (info.version ?? entry.preferred).trim();
  const updatedAt = parseTimestamp(ver.updated) || parseTimestamp(entry.added) || 0;

  const searchText = normalizeText(
    `${name} ${providerName} ${providerKey} ${summary.slice(0, 300)} ${categories.replace(/,/g, " ")}`,
  );

  return {
    id: providerKey,
    name,
    summary,
    spec_url: specUrl,
    origin_url: originUrl,
    provider_name: providerName,
    logo_url: logoUrl,
    categories,
    version,
    updated_at: updatedAt,
    search_text: searchText,
    search_compact: compactText(searchText),
  };
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

export function createDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS api_catalog (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      summary TEXT NOT NULL,
      spec_url TEXT NOT NULL,
      origin_url TEXT NOT NULL DEFAULT '',
      provider_name TEXT NOT NULL,
      logo_url TEXT NOT NULL DEFAULT '',
      categories TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0,
      search_text TEXT NOT NULL,
      search_compact TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_name ON api_catalog(name);
    CREATE INDEX IF NOT EXISTS idx_catalog_updated ON api_catalog(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_catalog_provider ON api_catalog(provider_name);
    CREATE INDEX IF NOT EXISTS idx_catalog_search ON api_catalog(search_compact);
  `);
  return db;
}

export function rowCount(db: Database): number {
  const row = db.query("SELECT COUNT(*) AS count FROM api_catalog").get() as { count: number } | null;
  return row?.count ?? 0;
}

function upsertRows(db: Database, rows: ApiRow[]): void {
  if (rows.length === 0) return;

  const upsert = db.query(`
    INSERT INTO api_catalog (
      id, name, summary, spec_url, origin_url,
      provider_name, logo_url, categories, version,
      updated_at, search_text, search_compact
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      summary = excluded.summary,
      spec_url = excluded.spec_url,
      origin_url = excluded.origin_url,
      provider_name = excluded.provider_name,
      logo_url = excluded.logo_url,
      categories = excluded.categories,
      version = excluded.version,
      updated_at = excluded.updated_at,
      search_text = excluded.search_text,
      search_compact = excluded.search_compact
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const r of rows) {
      upsert.run(
        r.id, r.name, r.summary, r.spec_url, r.origin_url,
        r.provider_name, r.logo_url, r.categories, r.version,
        r.updated_at, r.search_text, r.search_compact,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

async function loadSupplements(): Promise<ListJson> {
  try {
    const file = Bun.file(SUPPLEMENTS_PATH);
    if (!(await file.exists())) return {};
    const data = (await file.json()) as ListJson & { $comment?: string };
    delete data.$comment;
    return data;
  } catch {
    return {};
  }
}

async function fetchAndSync(db: Database, config: SyncConfig): Promise<number> {
  const url = config.listUrl || DEFAULT_LIST_URL;
  console.log(`[scraper] fetching ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch list.json: HTTP ${response.status}`);
  }

  const data = (await response.json()) as ListJson;

  // Merge local supplements (overrides upstream if same key)
  const supplements = await loadSupplements();
  const supplementCount = Object.keys(supplements).length;
  if (supplementCount > 0) {
    Object.assign(data, supplements);
    console.log(`[scraper] merged ${supplementCount} supplemental entries`);
  }

  const entries = Object.entries(data);
  console.log(`[scraper] parsing ${entries.length} entries`);

  const rows: ApiRow[] = [];
  for (const [key, entry] of entries) {
    const row = mapEntry(key, entry);
    if (row) rows.push(row);
  }

  // Batch upsert in chunks of 500
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    upsertRows(db, rows.slice(i, i + CHUNK));
  }

  const count = rowCount(db);
  console.log(`[scraper] synced ${rows.length} rows (${count} total in db)`);
  return count;
}

export function triggerSync(
  db: Database,
  state: SyncState,
  config: SyncConfig,
  trigger: string,
): Promise<SyncResult> {
  if (state.inFlight) return state.inFlight;

  const promise = fetchAndSync(db, config)
    .then((count) => {
      const syncedAt = Date.now();
      state.lastSyncedAt = syncedAt;
      state.lastError = null;
      state.lastCount = count;
      return { count, syncedAt, trigger } satisfies SyncResult;
    })
    .catch((error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    })
    .finally(() => {
      state.inFlight = null;
    });

  state.inFlight = promise;
  return promise;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

function buildSearchFilter(q: string): { sql: string; params: string[] } {
  const trimmed = q.trim();
  if (!trimmed) return { sql: "", params: [] };

  const normalized = normalizeText(trimmed);
  const compact = compactText(normalized);
  const tokens = normalized.split(/\s+/).filter(Boolean);

  const clauses: string[] = [];
  const params: string[] = [];

  if (compact.length > 0) {
    clauses.push("search_compact LIKE ?");
    params.push(`%${compact}%`);
  }

  for (const token of tokens) {
    clauses.push("search_text LIKE ?");
    params.push(`%${token}%`);
  }

  return {
    sql: `WHERE (${clauses.join(" OR ")})`,
    params,
  };
}

export function queryCollections(db: Database, input: {
  q: string;
  sort: "popular" | "recent";
  limit: number;
  offset: number;
}): { items: CatalogItem[]; totalCount: number; hasMore: boolean } {
  const { sql, params } = buildSearchFilter(input.q);

  const countRow = db.query(
    `SELECT COUNT(*) AS count FROM api_catalog ${sql}`,
  ).get(...params) as { count: number } | null;
  const totalCount = countRow?.count ?? 0;

  // "popular" → alphabetical by name (no popularity metric from APIs.guru)
  // "recent" → by updated_at desc
  const orderBy = input.sort === "recent"
    ? "updated_at DESC, name COLLATE NOCASE ASC"
    : "name COLLATE NOCASE ASC";

  const rows = db.query(`
    SELECT
      id, name, summary, spec_url AS specUrl,
      origin_url AS originUrl, provider_name AS providerName,
      logo_url AS logoUrl, categories, version
    FROM api_catalog ${sql}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, input.limit, input.offset) as CatalogItem[];

  return {
    items: rows,
    totalCount,
    hasMore: input.offset + rows.length < totalCount,
  };
}

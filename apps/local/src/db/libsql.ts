import { createClient, type Client, type InArgs, type ResultSet } from "@libsql/client";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// libSQL connection helper for the local server. libSQL opens a connection per
// `createClient`, so the per-connection PRAGMAs (foreign_keys, WAL) must be
// re-applied on every client (they no longer carry over from one shared
// handle). This helper centralizes the `file:` URL construction and the
// per-connection PRAGMA set so every open site stays consistent.
// ---------------------------------------------------------------------------

/**
 * Build a libSQL `file:` URL from a filesystem path. libSQL requires an
 * absolute path for `file:` URLs; `:memory:` passes through unchanged.
 */
const toLibsqlFileUrl = (path: string): string =>
  path === ":memory:" ? path : `file:${resolve(path)}`;

/**
 * Open a libSQL client for a local on-disk DB and apply the per-connection
 * PRAGMAs (foreign_keys + WAL). Used for the long-lived FumaDB handle.
 */
export const openLocalLibsql = async (path: string): Promise<Client> => {
  const client = createClient({ url: toLibsqlFileUrl(path) });
  // foreign_keys is strictly per-connection; WAL is a file-level mode set on
  // first enabling. Re-apply both since libSQL gives no shared handle.
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA journal_mode = WAL");
  return client;
};

const asRows = <T>(result: ResultSet): readonly T[] =>
  // oxlint-disable-next-line executor/no-double-cast -- boundary: SQLite result columns are the schema contract for T; libSQL rows are narrowed once here
  result.rows as unknown as readonly T[];

export const executeSql = async (client: Client, sql: string, args?: InArgs): Promise<ResultSet> =>
  client.execute(args ? { sql, args } : sql);

export const queryRows = async <T>(
  client: Client,
  sql: string,
  args?: InArgs,
): Promise<readonly T[]> => asRows<T>(await executeSql(client, sql, args));

export const queryFirst = async <T>(
  client: Client,
  sql: string,
  args?: InArgs,
): Promise<T | null> => (await queryRows<T>(client, sql, args))[0] ?? null;

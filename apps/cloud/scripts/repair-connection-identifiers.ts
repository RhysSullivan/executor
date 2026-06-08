/* oxlint-disable executor/no-error-constructor, executor/no-try-catch-or-throw -- boundary: one-shot operator repair script fails hard on unsafe preconditions */
/**
 * Repair persisted connection names so callable connection segments are valid
 * JS identifiers.
 *
 * Dry-run:
 *
 *   op run --env-file=apps/cloud/.env.production -- \
 *     bun apps/cloud/scripts/repair-connection-identifiers.ts
 *
 * Apply:
 *
 *   op run --env-file=apps/cloud/.env.production -- \
 *     bun apps/cloud/scripts/repair-connection-identifiers.ts --apply --confirm-connection-identifier-repair
 */
import postgres, { type Sql } from "postgres";

import { connectionIdentifier, isConnectionIdentifier } from "@executor-js/sdk/shared";

type Pg = Sql<Record<string, unknown>>;

interface ConnectionRow {
  readonly tenant: string;
  readonly owner: "org" | "user";
  readonly subject: string;
  readonly integration: string;
  readonly name: string;
}

interface RepairRow {
  readonly tenant: string;
  readonly owner: "org" | "user";
  readonly subject: string;
  readonly integration: string;
  readonly currentName: string;
  readonly repairedName: string;
}

const APPLY = process.argv.includes("--apply");
const CONFIRM = process.argv.includes("--confirm-connection-identifier-repair");

const repairRows = (rows: readonly ConnectionRow[]): readonly RepairRow[] =>
  rows
    .filter((row) => !isConnectionIdentifier(row.name))
    .map((row) => ({
      tenant: row.tenant,
      owner: row.owner,
      subject: row.subject,
      integration: row.integration,
      currentName: row.name,
      repairedName: String(connectionIdentifier(row.name)),
    }));

const assertNoCollisions = (rows: readonly ConnectionRow[]): void => {
  const normalized = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = [
      row.tenant,
      row.owner,
      row.subject,
      row.integration,
      String(connectionIdentifier(row.name)),
    ].join("\0");
    const names = normalized.get(key) ?? new Set<string>();
    names.add(row.name);
    normalized.set(key, names);
  }

  const collisions = [...normalized.entries()].filter(([, names]) => names.size > 1);
  if (collisions.length === 0) return;

  for (const [key, names] of collisions) {
    console.error(`collision ${key.replaceAll("\0", "/")}: ${[...names].join(", ")}`);
  }
  throw new Error("Refusing repair because normalized connection names collide.");
};

const repair = async (sql: Pg): Promise<void> => {
  const rows = await sql<ConnectionRow[]>`
    select tenant, owner, subject, integration, name
    from connection
    order by tenant, owner, subject, integration, name
  `;
  const changes = repairRows(rows);
  const policyRows = await sql<{ readonly count: number }[]>`
    select count(*)::int as count
    from tool_policy
    where pattern ~ '-'
  `;

  console.log(`connection repair: ${rows.length} connection(s) checked`);
  console.log(`connection repair: ${changes.length} connection(s) need identifier rename`);
  for (const row of changes) {
    console.log(
      `  - ${row.tenant}/${row.owner}/${row.subject || "<org>"}/${row.integration}: ${row.currentName} -> ${row.repairedName}`,
    );
  }

  assertNoCollisions(rows);
  if ((policyRows[0]?.count ?? 0) > 0) {
    throw new Error(
      "Refusing repair because tool_policy has dash-containing patterns; policy rewrite needs to be explicit.",
    );
  }

  if (!APPLY) return;
  if (!CONFIRM) {
    throw new Error("Refusing apply without --confirm-connection-identifier-repair.");
  }

  const now = new Date();
  await sql.begin(async (tx) => {
    for (const row of changes) {
      await (tx as Pg)`
        update tool
        set connection = ${row.repairedName}
        where tenant = ${row.tenant}
          and owner = ${row.owner}
          and subject = ${row.subject}
          and integration = ${row.integration}
          and connection = ${row.currentName}
      `;
      await (tx as Pg)`
        update definition
        set connection = ${row.repairedName}
        where tenant = ${row.tenant}
          and owner = ${row.owner}
          and subject = ${row.subject}
          and integration = ${row.integration}
          and connection = ${row.currentName}
      `;
      await (tx as Pg)`
        update connection
        set name = ${row.repairedName}, updated_at = ${now}
        where tenant = ${row.tenant}
          and owner = ${row.owner}
          and subject = ${row.subject}
          and integration = ${row.integration}
          and name = ${row.currentName}
      `;
    }
  });
  console.log("connection repair: complete");
};

const main = async (): Promise<void> => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (run via `op run --env-file=.env.production --`).");
    process.exit(1);
  }
  const databaseSsl = process.env.DATABASE_SSL?.trim().toLowerCase();
  const ssl =
    databaseSsl === "disable" || databaseSsl === "false" || databaseSsl === "0" ? false : "require";
  const sql = postgres(databaseUrl, { max: 1, prepare: false, ssl }) as Pg;
  try {
    await repair(sql);
  } finally {
    await sql.end();
  }
};

if (import.meta.main) {
  await main();
}

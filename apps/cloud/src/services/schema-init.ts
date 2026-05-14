import { sql } from "drizzle-orm";

interface ExecutableDrizzleDb {
  readonly execute: (query: ReturnType<typeof sql.raw>) => Promise<unknown>;
}

const statements = [
  `CREATE TABLE IF NOT EXISTS "accounts" (
    "id" text PRIMARY KEY NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS "organizations" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS "memberships" (
    "account_id" text NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
    "organization_id" text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
    "created_at" timestamp with time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("account_id", "organization_id")
  )`,
] as const;

export const ensureCloudSchema = async (db: ExecutableDrizzleDb): Promise<void> => {
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

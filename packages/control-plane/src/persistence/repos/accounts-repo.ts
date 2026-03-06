import { type Account, AccountSchema } from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { and, eq } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption } from "./shared";

const decodeAccount = Schema.decodeUnknownSync(AccountSchema);

export const createAccountsRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  getById: (accountId: Account["id"]) =>
    client.use("rows.accounts.get_by_id", async (db) => {
      const rows = await db
        .select()
        .from(tables.accountsTable)
        .where(eq(tables.accountsTable.id, accountId))
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeAccount(row.value))
        : Option.none<Account>();
    }),

  getByProviderAndSubject: (
    provider: Account["provider"],
    subject: Account["subject"],
  ) =>
    client.use("rows.accounts.get_by_provider_and_subject", async (db) => {
      const rows = await db
        .select()
        .from(tables.accountsTable)
        .where(
          and(
            eq(tables.accountsTable.provider, provider),
            eq(tables.accountsTable.subject, subject),
          ),
        )
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeAccount(row.value))
        : Option.none<Account>();
    }),

  insert: (account: Account) =>
    client.use("rows.accounts.insert", async (db) => {
      await db.insert(tables.accountsTable).values(account);
    }),

  upsert: (account: Account) =>
    client.use("rows.accounts.upsert", async (db) => {
      await db
        .insert(tables.accountsTable)
        .values(account)
        .onConflictDoUpdate({
          target: [tables.accountsTable.provider, tables.accountsTable.subject],
          set: {
            email: account.email,
            displayName: account.displayName,
            updatedAt: account.updatedAt,
          },
        });
    }),
});

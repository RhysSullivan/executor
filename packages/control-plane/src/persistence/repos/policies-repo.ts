import { type Policy, PolicySchema } from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { asc, desc, eq } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption } from "./shared";

const decodePolicy = Schema.decodeUnknownSync(PolicySchema);

export const createPoliciesRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  listByWorkspaceId: (workspaceId: Policy["workspaceId"]) =>
    client.use("rows.policies.list_by_workspace", async (db) => {
      const rows = await db
        .select()
        .from(tables.policiesTable)
        .where(eq(tables.policiesTable.workspaceId, workspaceId))
        .orderBy(desc(tables.policiesTable.priority), asc(tables.policiesTable.updatedAt));

      return rows.map((row) => decodePolicy(row));
    }),

  getById: (policyId: Policy["id"]) =>
    client.use("rows.policies.get_by_id", async (db) => {
      const rows = await db
        .select()
        .from(tables.policiesTable)
        .where(eq(tables.policiesTable.id, policyId))
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodePolicy(row.value))
        : Option.none<Policy>();
    }),

  insert: (policy: Policy) =>
    client.use("rows.policies.insert", async (db) => {
      await db.insert(tables.policiesTable).values(policy);
    }),

  update: (
    policyId: Policy["id"],
    patch: Partial<Omit<Policy, "id" | "workspaceId" | "createdAt">>,
  ) =>
    client.use("rows.policies.update", async (db) => {
      const rows = await db
        .update(tables.policiesTable)
        .set(patch)
        .where(eq(tables.policiesTable.id, policyId))
        .returning();

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodePolicy(row.value))
        : Option.none<Policy>();
    }),

  removeById: (policyId: Policy["id"]) =>
    client.use("rows.policies.remove", async (db) => {
      const deleted = await db
        .delete(tables.policiesTable)
        .where(eq(tables.policiesTable.id, policyId))
        .returning();

      return deleted.length > 0;
    }),
});

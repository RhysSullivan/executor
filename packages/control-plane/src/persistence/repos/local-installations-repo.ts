import {
  type LocalInstallation,
  LocalInstallationSchema,
} from "#schema";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { eq } from "drizzle-orm";

import type { DrizzleClient } from "../client";
import type { DrizzleTables } from "../schema";
import { firstOption } from "./shared";

const decodeLocalInstallation = Schema.decodeUnknownSync(LocalInstallationSchema);

export const createLocalInstallationsRepo = (
  client: DrizzleClient,
  tables: DrizzleTables,
) => ({
  getById: (installationId: LocalInstallation["id"]) =>
    client.use("rows.local_installations.get_by_id", async (db) => {
      const rows = await db
        .select()
        .from(tables.localInstallationsTable)
        .where(eq(tables.localInstallationsTable.id, installationId))
        .limit(1);

      const row = firstOption(rows);
      return Option.isSome(row)
        ? Option.some(decodeLocalInstallation(row.value))
        : Option.none<LocalInstallation>();
    }),

  upsert: (installation: LocalInstallation) =>
    client.use("rows.local_installations.upsert", async (db) => {
      await db
        .insert(tables.localInstallationsTable)
        .values(installation)
        .onConflictDoUpdate({
          target: tables.localInstallationsTable.id,
          set: {
            accountId: installation.accountId,
            organizationId: installation.organizationId,
            workspaceId: installation.workspaceId,
            updatedAt: installation.updatedAt,
          },
        });
    }),
});

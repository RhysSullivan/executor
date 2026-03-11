import { createSelectSchema } from "drizzle-orm/effect-schema";

import { codeMigrationsTable } from "../../persistence/schema";
import { TimestampMsSchema } from "../common";

export const StoredCodeMigrationRecordSchema = createSelectSchema(
  codeMigrationsTable,
  {
    appliedAt: TimestampMsSchema,
  },
);

export type StoredCodeMigrationRecord =
  typeof StoredCodeMigrationRecordSchema.Type;

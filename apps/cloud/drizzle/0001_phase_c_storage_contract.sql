-- Phase C: align the legacy storage-postgres schema with the new
-- `@executor/storage` contract. The new `makeStorageSecretStore` writes
-- a `provider` label alongside encrypted values, and treats the
-- encrypted payload + iv as optional so provider-pinned refs can be
-- persisted without inline ciphertext. Existing storage-encrypted rows
-- stay valid; new rows can distinguish between storage-encrypted and
-- provider-pinned secrets.
--
-- Also adds the new adapter's expected indexes for tools + plugin_kv.

ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "provider" text;
--> statement-breakpoint
ALTER TABLE "secrets" ALTER COLUMN "encrypted_value" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "secrets" ALTER COLUMN "iv" DROP NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tools_source" ON "tools" ("organization_id", "source_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_plugin_kv_namespace" ON "plugin_kv" ("organization_id", "namespace");

/* oxlint-disable executor/no-try-catch-or-throw -- boundary: DB ownership test must close the held DB/lock handle even when assertions fail */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { collectTables } from "@executor-js/api/server";

import { acquireDataDirOwnership, DataDirOwnershipHeld } from "./data-dir-ownership";
import { openOwnedLocalDatabase, type OwnedLocalDatabase } from "./owned-database";

const LOCK_DATABASE_FILENAME = "data.db.owner-lock";

const makeOwnedTestDatabase = (dataDir: string) =>
  openOwnedLocalDatabase({
    dataDir,
    tables: collectTables(),
    namespace: "executor_local_owned_database_test",
    tenantId: "owned-database-test-tenant",
  });

describe("openOwnedLocalDatabase", () => {
  it("holds data-dir ownership until the serving database is closed", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "executor-owned-database-"));
    const dataDir = join(workDir, "data");
    let owned: OwnedLocalDatabase | null = null;

    try {
      owned = await makeOwnedTestDatabase(dataDir);
      const realDataDir = realpathSync(dataDir);
      const expectedLockPath = join(realDataDir, LOCK_DATABASE_FILENAME);

      expect(owned).toMatchObject({
        dataDir: realDataDir,
        sqlitePath: join(realDataDir, "data.db"),
        lockPath: expectedLockPath,
        migration: { migrated: false, warnings: [] },
      });

      await expect(acquireDataDirOwnership(dataDir)).rejects.toBeInstanceOf(DataDirOwnershipHeld);

      await owned.close();
      owned = null;

      const ownership = await acquireDataDirOwnership(dataDir);
      try {
        expect(ownership.lockPath).toBe(expectedLockPath);
      } finally {
        await ownership.release();
      }
    } finally {
      if (owned) await owned.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

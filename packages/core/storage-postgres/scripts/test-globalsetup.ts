// ---------------------------------------------------------------------------
// Vitest globalSetup — starts an in-process PGlite socket server so the
// conformance suite can run against a real postgres without requiring
// a TEST_POSTGRES_URL. Mirrors apps/cloud/scripts/test-globalsetup.ts.
//
// No drizzle migrations here — the conformance test creates/drops its
// own tables per run via raw SQL.
// ---------------------------------------------------------------------------

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const PORT = 5435;

let db: PGlite | undefined;
let server: PGLiteSocketServer | undefined;

export default async function setup() {
  db = await PGlite.create();
  // PGlite defaults to the host's local timezone; pin to UTC so the
  // conformance suite's Date assertions match across machines (real
  // Postgres sessions default to UTC).
  await db.exec("SET TIMEZONE TO 'UTC';");

  server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
  await server.start();
  // eslint-disable-next-line no-console
  console.log(`[test-db] PGlite socket server listening on 127.0.0.1:${PORT}`);

  return async () => {
    await server?.stop();
    await db?.close();
  };
}

// ---------------------------------------------------------------------------
// Vitest globalSetup — starts an in-process PGlite socket server so tests
// running in the Cloudflare Workers runtime can connect to a real Postgres
// via postgres.js. Port must match DATABASE_URL in wrangler.test.jsonc.
// ---------------------------------------------------------------------------

import { collectTables } from "@executor-js/sdk";
import executorConfig from "../executor.config";
import { ensureCloudSchema } from "../src/services/schema-init";
import { createPgliteFumaDb, type PgliteFumaDb } from "../src/services/pglite";

const PORT = 5434;

let runtime: PgliteFumaDb | undefined;

export default async function setup() {
  runtime = await createPgliteFumaDb({
    tables: collectTables(executorConfig.plugins({})),
    namespace: "executor_cloud",
    port: PORT,
    host: "127.0.0.1",
  });
  await ensureCloudSchema(runtime.drizzle);
  // eslint-disable-next-line no-console
  console.log(`[test-db] PGlite socket server listening on 127.0.0.1:${PORT}`);

  return async () => {
    await runtime?.close();
  };
}

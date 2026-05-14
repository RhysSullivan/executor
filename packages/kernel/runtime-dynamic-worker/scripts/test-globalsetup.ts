import { collectTables } from "@executor-js/sdk";
import { createPgliteFumaDb, type PgliteFumaDb } from "@executor-js/sdk/pglite";
import { openApiPlugin } from "@executor-js/plugin-openapi";

const PORT = 5435;
const DATABASE_NAMESPACE = "executor_worker_test";

let runtime: PgliteFumaDb | undefined;

export default async function setup() {
  runtime = await createPgliteFumaDb({
    tables: collectTables([openApiPlugin()] as const),
    namespace: DATABASE_NAMESPACE,
    host: "127.0.0.1",
    port: PORT,
  });

  return async () => {
    await runtime?.close();
  };
}

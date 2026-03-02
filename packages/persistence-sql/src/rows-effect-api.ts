import { createAuthRowsEffectApi } from "./rows-effect-api-auth";
import { createCoreRowsEffectApi } from "./rows-effect-api-core";
import { type RowOperations } from "./rows-effect-helpers";
import { type SqlBackend } from "./sql-internals";

export const createRowsEffectApi = (
  backend: SqlBackend,
  operations: RowOperations,
) => ({
  ...createCoreRowsEffectApi(backend, operations),
  ...createAuthRowsEffectApi(backend, operations),
});

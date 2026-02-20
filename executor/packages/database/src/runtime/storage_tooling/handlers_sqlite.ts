import {
  sqliteCapabilitiesInputSchema,
  sqliteCapabilitiesOutputSchema,
  sqliteInsertRowsInputSchema,
  sqliteInsertRowsOutputSchema,
  sqliteQueryInputSchema,
  sqliteQueryOutputSchema,
} from "../storage_tool_contracts/sqlite";
import {
  assertSqlIdentifier,
  decorateSqliteError,
  isReadOnlySql,
  quoteSqlIdentifier,
  resolveStorageProviderForPayload,
  SQLITE_MAX_BIND_VARIABLES,
  touchInstance,
  type StorageToolHandlerArgs,
} from "./context";

export async function runSqliteHandler(args: StorageToolHandlerArgs): Promise<unknown | undefined> {
  const {
    ctx,
    task,
    payload,
    normalizedToolPath,
  } = args;

  if (normalizedToolPath === "sqlite.capabilities") {
    sqliteCapabilitiesInputSchema.parse(payload);
    const { instance, provider } = await resolveStorageProviderForPayload(ctx, task, payload);
    await touchInstance(ctx, task, instance, provider, false);
    return sqliteCapabilitiesOutputSchema.parse({
      instanceId: instance.id,
      provider: instance.provider,
      maxBindVariables: SQLITE_MAX_BIND_VARIABLES,
      supportsJsonEach: true,
      supportsInsertRowsTool: true,
      guidance: [
        "Prefer sqlite.insert_rows for bulk tabular inserts.",
        "Keep bind params per statement under maxBindVariables.",
        "For very large payloads, use one JSON payload param and expand with json_each(?).",
        "Pass instanceId explicitly to reuse the same database across task runs.",
      ],
    });
  }

  if (normalizedToolPath === "sqlite.insert_rows") {
    const parsed = sqliteInsertRowsInputSchema.parse(payload);
    const { instance, provider } = await resolveStorageProviderForPayload(ctx, task, payload);

    const table = assertSqlIdentifier(parsed.table, "table");
    const columns = parsed.columns.map((column, index) => assertSqlIdentifier(column, `columns[${index}]`));
    if (new Set(columns).size !== columns.length) {
      throw new Error("columns must be unique");
    }

    const rows = parsed.rows;
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index].length !== columns.length) {
        throw new Error(`rows[${index}] has ${rows[index].length} values but expected ${columns.length}`);
      }
    }

    const maxRowsPerChunk = Math.max(1, Math.floor(SQLITE_MAX_BIND_VARIABLES / Math.max(1, columns.length)));
    const requestedChunkSize = typeof parsed.chunkSize === "number" && Number.isFinite(parsed.chunkSize)
      ? Math.max(1, Math.floor(parsed.chunkSize))
      : maxRowsPerChunk;
    const rowsPerChunk = Math.max(1, Math.min(maxRowsPerChunk, requestedChunkSize));

    const conflictClause = parsed.onConflict === "ignore"
      ? " OR IGNORE"
      : parsed.onConflict === "replace"
        ? " OR REPLACE"
        : "";

    const quotedTable = quoteSqlIdentifier(table);
    const quotedColumns = columns.map(quoteSqlIdentifier).join(", ");
    const placeholderRow = `(${columns.map(() => "?").join(", ")})`;

    let totalChanges = 0;
    let chunkCount = 0;
    for (let start = 0; start < rows.length; start += rowsPerChunk) {
      const chunk = rows.slice(start, start + rowsPerChunk);
      const values = chunk.map(() => placeholderRow).join(", ");
      const params = chunk.flat();
      const sql = `INSERT${conflictClause} INTO ${quotedTable} (${quotedColumns}) VALUES ${values}`;

      let writeResult;
      try {
        writeResult = await provider.sqliteQuery(instance, {
          sql,
          params,
          mode: "write",
          maxRows: 1,
        });
      } catch (error) {
        throw decorateSqliteError(error, {
          sql,
          params,
          instanceId: instance.id,
        });
      }

      totalChanges += Number(writeResult.changes ?? 0);
      chunkCount += 1;
    }

    await touchInstance(ctx, task, instance, provider, true);
    return sqliteInsertRowsOutputSchema.parse({
      instanceId: instance.id,
      table,
      columns,
      rowsReceived: rows.length,
      rowsProcessed: rows.length,
      chunkCount,
      rowsPerChunk,
      maxBindVariables: SQLITE_MAX_BIND_VARIABLES,
      changes: totalChanges,
    });
  }

  if (normalizedToolPath === "sqlite.query") {
    const parsed = sqliteQueryInputSchema.parse(payload);
    const { instance, provider } = await resolveStorageProviderForPayload(ctx, task, payload);
    const mode = parsed.mode ?? (isReadOnlySql(parsed.sql) ? "read" : "write");
    const maxRows = Math.max(1, Math.min(1_000, Math.floor(parsed.maxRows ?? 200)));
    const params = parsed.params ?? [];
    let result;
    try {
      result = await provider.sqliteQuery(instance, {
        sql: parsed.sql,
        params,
        mode,
        maxRows,
      });
    } catch (error) {
      throw decorateSqliteError(error, {
        sql: parsed.sql,
        params,
        instanceId: instance.id,
      });
    }
    await touchInstance(ctx, task, instance, provider, mode === "write");
    return sqliteQueryOutputSchema.parse({
      instanceId: instance.id,
      ...result,
    });
  }

  return undefined;
}

import type { ActionCtx } from "../../convex/_generated/server";
import type { TaskRecord } from "../../../core/src/types";
import { normalizeInputPayload } from "./storage_tooling/context";
import { runFsHandler } from "./storage_tooling/handlers_fs";
import { runKvHandler } from "./storage_tooling/handlers_kv";
import { runSqliteHandler } from "./storage_tooling/handlers_sqlite";
import { runStorageInstanceHandler } from "./storage_tooling/handlers_storage";

const STORAGE_TOOL_ALIASES: Record<string, string> = {
  "kv.put": "kv.set",
  "kv.create": "kv.set",
  "kv.update": "kv.set",
  "kv.del": "kv.delete",
  "kv.has": "kv.get",
  "kv.exists": "kv.get",
  "kv.value": "kv.get",
  "kv.keys": "kv.list",
  "sqlite.exec": "sqlite.query",
  "sqlite.bulk_insert": "sqlite.insert_rows",
};

const STORAGE_SYSTEM_TOOLS = new Set<string>([
  "storage.open",
  "storage.list",
  "storage.close",
  "storage.delete",
  "fs.read",
  "fs.write",
  "fs.readdir",
  "fs.stat",
  "fs.mkdir",
  "fs.remove",
  "kv.get",
  "kv.set",
  "kv.put",
  "kv.create",
  "kv.update",
  "kv.list",
  "kv.keys",
  "kv.delete",
  "kv.del",
  "kv.has",
  "kv.exists",
  "kv.value",
  "kv.incr",
  "kv.decr",
  "sqlite.query",
  "sqlite.exec",
  "sqlite.capabilities",
  "sqlite.insert_rows",
  "sqlite.bulk_insert",
]);

function normalizeStorageToolPath(toolPath: string): string {
  return STORAGE_TOOL_ALIASES[toolPath] ?? toolPath;
}

export function isStorageSystemToolPath(path: string): boolean {
  return STORAGE_SYSTEM_TOOLS.has(path);
}

export async function runStorageSystemTool(
  ctx: ActionCtx,
  task: TaskRecord,
  toolPath: string,
  input: unknown,
): Promise<unknown> {
  const payload = normalizeInputPayload(input);
  const normalizedToolPath = normalizeStorageToolPath(toolPath);
  const handlerArgs = {
    ctx,
    task,
    payload,
    normalizedToolPath,
  };

  const instanceResult = await runStorageInstanceHandler(handlerArgs);
  if (instanceResult !== undefined) {
    return instanceResult;
  }

  const fsResult = await runFsHandler(handlerArgs);
  if (fsResult !== undefined) {
    return fsResult;
  }

  const kvResult = await runKvHandler(handlerArgs);
  if (kvResult !== undefined) {
    return kvResult;
  }

  const sqliteResult = await runSqliteHandler(handlerArgs);
  if (sqliteResult !== undefined) {
    return sqliteResult;
  }

  throw new Error(`Unsupported storage system tool: ${toolPath}`);
}

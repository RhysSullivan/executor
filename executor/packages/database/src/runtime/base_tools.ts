import type { ToolDefinition } from "../../../core/src/types";
import {
  catalogNamespacesInputJsonSchema,
  catalogNamespacesOutputJsonSchema,
  catalogToolsInputJsonSchema,
  catalogToolsOutputJsonSchema,
  discoverInputJsonSchema,
  discoverOutputJsonSchema,
} from "./discovery_tool_contracts";
import {
  fsMkdirInputJsonSchema,
  fsMkdirOutputJsonSchema,
  fsReadInputJsonSchema,
  fsReadOutputJsonSchema,
  fsReaddirInputJsonSchema,
  fsReaddirOutputJsonSchema,
  fsRemoveInputJsonSchema,
  fsRemoveOutputJsonSchema,
  fsStatInputJsonSchema,
  fsStatOutputJsonSchema,
  fsWriteInputJsonSchema,
  fsWriteOutputJsonSchema,
} from "./storage_tool_contracts/fs";
import {
  kvDeleteInputJsonSchema,
  kvDeleteOutputJsonSchema,
  kvGetInputJsonSchema,
  kvGetOutputJsonSchema,
  kvIncrInputJsonSchema,
  kvIncrOutputJsonSchema,
  kvListInputJsonSchema,
  kvListOutputJsonSchema,
  kvSetInputJsonSchema,
  kvSetOutputJsonSchema,
} from "./storage_tool_contracts/kv";
import {
  sqliteCapabilitiesInputJsonSchema,
  sqliteCapabilitiesOutputJsonSchema,
  sqliteInsertRowsInputJsonSchema,
  sqliteInsertRowsOutputJsonSchema,
  sqliteQueryInputJsonSchema,
  sqliteQueryOutputJsonSchema,
} from "./storage_tool_contracts/sqlite";
import {
  storageCloseInputJsonSchema,
  storageCloseOutputJsonSchema,
  storageDeleteInputJsonSchema,
  storageDeleteOutputJsonSchema,
  storageListInputJsonSchema,
  storageListOutputJsonSchema,
  storageOpenInputJsonSchema,
  storageOpenOutputJsonSchema,
} from "./storage_tool_contracts/storage";

export const baseTools = new Map<string, ToolDefinition>();

function registerSystemTool(
  path: string,
  description: string,
  typing: {
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  },
  approval: "auto" | "required" = "auto",
) {
  baseTools.set(path, {
    path,
    source: "system",
    approval,
    description,
    typing,
    run: async () => {
      throw new Error(`${path} is handled by the server tool invocation pipeline`);
    },
  });
}

// Built-in system tools are resolved server-side.
// Their execution is handled in the Convex tool invocation pipeline.
registerSystemTool(
  "discover",
  "Search available tools by keyword. Returns compact input/output hints by default; set includeSchemas=true for exact JSON Schemas.",
  {
    inputSchema: discoverInputJsonSchema,
    outputSchema: discoverOutputJsonSchema,
  },
);

registerSystemTool(
  "catalog.namespaces",
  "List available tool namespaces with counts and sample callable paths.",
  {
    inputSchema: catalogNamespacesInputJsonSchema,
    outputSchema: catalogNamespacesOutputJsonSchema,
  },
);

registerSystemTool(
  "catalog.tools",
  "List tools with compact hints by default. Supports namespace/query filters and optional includeSchemas for exact JSON Schemas.",
  {
    inputSchema: catalogToolsInputJsonSchema,
    outputSchema: catalogToolsOutputJsonSchema,
  },
);

registerSystemTool(
  "storage.open",
  "Open an existing storage instance or create a new one when instanceId is omitted. Saves a default instance for this task; pass instanceId explicitly when you need to reuse the same storage across separate tasks/runs.",
  {
    inputSchema: storageOpenInputJsonSchema,
    outputSchema: storageOpenOutputJsonSchema,
  },
);

registerSystemTool(
  "storage.list",
  "List accessible storage instances for the current workspace context.",
  {
    inputSchema: storageListInputJsonSchema,
    outputSchema: storageListOutputJsonSchema,
  },
);

registerSystemTool(
  "storage.close",
  "Mark a storage instance as closed without deleting its contents.",
  {
    inputSchema: storageCloseInputJsonSchema,
    outputSchema: storageCloseOutputJsonSchema,
  },
);

registerSystemTool(
  "storage.delete",
  "Delete a storage instance and its backing data.",
  {
    inputSchema: storageDeleteInputJsonSchema,
    outputSchema: storageDeleteOutputJsonSchema,
  },
);

registerSystemTool(
  "fs.read",
  "Read a file from a storage instance. Reuses the current default instance when instanceId is omitted.",
  {
    inputSchema: fsReadInputJsonSchema,
    outputSchema: fsReadOutputJsonSchema,
  },
);

registerSystemTool(
  "fs.write",
  "Write file contents into a storage instance. Reuses the current default instance when instanceId is omitted.",
  {
    inputSchema: fsWriteInputJsonSchema,
    outputSchema: fsWriteOutputJsonSchema,
  },
);

registerSystemTool(
  "fs.readdir",
  "List directory entries in a storage instance.",
  {
    inputSchema: fsReaddirInputJsonSchema,
    outputSchema: fsReaddirOutputJsonSchema,
  },
);

registerSystemTool(
  "fs.stat",
  "Get metadata for a filesystem path in storage.",
  {
    inputSchema: fsStatInputJsonSchema,
    outputSchema: fsStatOutputJsonSchema,
  },
);

registerSystemTool(
  "fs.mkdir",
  "Create a directory in a storage instance.",
  {
    inputSchema: fsMkdirInputJsonSchema,
    outputSchema: fsMkdirOutputJsonSchema,
  },
);

registerSystemTool(
  "fs.remove",
  "Remove a file or directory from a storage instance.",
  {
    inputSchema: fsRemoveInputJsonSchema,
    outputSchema: fsRemoveOutputJsonSchema,
  },
);

registerSystemTool(
  "kv.get",
  "Read a key-value entry from a storage instance.",
  {
    inputSchema: kvGetInputJsonSchema,
    outputSchema: kvGetOutputJsonSchema,
  },
);

registerSystemTool(
  "kv.set",
  "Write a key-value entry into a storage instance.",
  {
    inputSchema: kvSetInputJsonSchema,
    outputSchema: kvSetOutputJsonSchema,
  },
);

registerSystemTool(
  "kv.put",
  "Alias for kv.set. Write a key-value entry into a storage instance.",
  {
    inputSchema: kvSetInputJsonSchema,
    outputSchema: kvSetOutputJsonSchema,
  },
);

registerSystemTool(
  "kv.create",
  "Alias for kv.set. Create a key-value entry in a storage instance.",
  {
    inputSchema: kvSetInputJsonSchema,
    outputSchema: kvSetOutputJsonSchema,
  },
);

registerSystemTool(
  "kv.update",
  "Alias for kv.set. Update a key-value entry in a storage instance.",
  {
    inputSchema: kvSetInputJsonSchema,
    outputSchema: kvSetOutputJsonSchema,
  },
);

registerSystemTool(
  "kv.list",
  "List key-value entries by prefix from a storage instance.",
  {
    inputSchema: kvListInputJsonSchema,
    outputSchema: kvListOutputJsonSchema,
  },
);

registerSystemTool(
  "kv.keys",
  "Alias for kv.list. List keys by prefix from a storage instance.",
  {
    inputSchema: kvListInputJsonSchema,
    outputSchema: kvListOutputJsonSchema,
  },
);

registerSystemTool(
  "kv.delete",
  "Delete a key-value entry from a storage instance.",
  {
    inputSchema: kvDeleteInputJsonSchema,
    outputSchema: kvDeleteOutputJsonSchema,
  },
);

registerSystemTool(
  "kv.del",
  "Alias for kv.delete. Delete a key-value entry from a storage instance.",
  {
    inputSchema: kvDeleteInputJsonSchema,
    outputSchema: kvDeleteOutputJsonSchema,
  },
);

registerSystemTool(
  "kv.has",
  "Alias for kv.get. Check whether a key exists in a storage instance.",
  {
    inputSchema: kvGetInputJsonSchema,
    outputSchema: kvGetOutputJsonSchema,
  },
);

registerSystemTool(
  "kv.exists",
  "Alias for kv.get. Check whether a key exists in a storage instance.",
  {
    inputSchema: kvGetInputJsonSchema,
    outputSchema: kvGetOutputJsonSchema,
  },
);

registerSystemTool(
  "kv.value",
  "Alias for kv.get. Read a key-value entry from a storage instance.",
  {
    inputSchema: kvGetInputJsonSchema,
    outputSchema: kvGetOutputJsonSchema,
  },
);

registerSystemTool(
  "kv.incr",
  "Increment a numeric key-value entry and return the updated value. Creates the key from initial when missing.",
  {
    inputSchema: kvIncrInputJsonSchema,
    outputSchema: kvIncrOutputJsonSchema,
  },
);

registerSystemTool(
  "kv.decr",
  "Decrement a numeric key-value entry and return the updated value. Creates the key from initial when missing.",
  {
    inputSchema: kvIncrInputJsonSchema,
    outputSchema: kvIncrOutputJsonSchema,
  },
);

registerSystemTool(
  "sqlite.query",
  "Run SQL against storage-backed SQLite. Use mode='write' for mutating SQL. For multi-task persistence, pass instanceId explicitly. For bulk inserts, chunk into smaller batches or use json_each(?) with a JSON payload to avoid SQLite bind-variable limits.",
  {
    inputSchema: sqliteQueryInputJsonSchema,
    outputSchema: sqliteQueryOutputJsonSchema,
  },
);

registerSystemTool(
  "sqlite.exec",
  "Alias for sqlite.query. Run SQL against storage-backed SQLite with the same guidance on mode, instanceId reuse, and bulk inserts via chunking or json_each(?).",
  {
    inputSchema: sqliteQueryInputJsonSchema,
    outputSchema: sqliteQueryOutputJsonSchema,
  },
);

registerSystemTool(
  "sqlite.capabilities",
  "Return SQLite execution limits and import guidance for the active storage provider.",
  {
    inputSchema: sqliteCapabilitiesInputJsonSchema,
    outputSchema: sqliteCapabilitiesOutputJsonSchema,
  },
);

registerSystemTool(
  "sqlite.insert_rows",
  "Insert rows into a table with automatic chunking under bind-variable limits. Use for bulk imports instead of huge VALUES clauses.",
  {
    inputSchema: sqliteInsertRowsInputJsonSchema,
    outputSchema: sqliteInsertRowsOutputJsonSchema,
  },
);

registerSystemTool(
  "sqlite.bulk_insert",
  "Alias for sqlite.insert_rows. Bulk insert rows with automatic chunking.",
  {
    inputSchema: sqliteInsertRowsInputJsonSchema,
    outputSchema: sqliteInsertRowsOutputJsonSchema,
  },
);

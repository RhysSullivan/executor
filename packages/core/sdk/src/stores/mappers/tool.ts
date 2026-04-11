import { ToolId, ScopeId } from "../../ids";
import { ToolRegistration } from "../../tools";
import { normalizeRefs } from "../../schema-refs";
import type { ToolRow } from "../tool-store";

// ---------------------------------------------------------------------------
// Tool mappers — convert between ToolRow and ToolRegistration domain objects.
// ---------------------------------------------------------------------------

export const rowToToolRegistration = (row: ToolRow): ToolRegistration =>
  new ToolRegistration({
    id: ToolId.make(row.id),
    pluginKey: row.pluginKey,
    sourceId: row.sourceId,
    name: row.name,
    description: row.description ?? undefined,
    mayElicit: row.mayElicit ?? undefined,
    inputSchema: row.inputSchema ?? undefined,
    outputSchema: row.outputSchema ?? undefined,
  });

export const toolRegistrationToRow = (
  reg: ToolRegistration,
  scopeId: ScopeId,
): Omit<ToolRow, "createdAt"> => ({
  id: reg.id as string,
  scopeId: scopeId as string,
  sourceId: reg.sourceId,
  pluginKey: reg.pluginKey,
  name: reg.name,
  description: reg.description ?? null,
  mayElicit: reg.mayElicit ?? null,
  inputSchema: normalizeRefs(reg.inputSchema) ?? null,
  outputSchema: normalizeRefs(reg.outputSchema) ?? null,
});

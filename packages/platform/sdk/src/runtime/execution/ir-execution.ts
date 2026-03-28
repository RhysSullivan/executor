import type {
  ScopeId,
  Source,
} from "#schema";
import type {
  OnElicitation,
} from "@executor/codemode-core";
import * as Effect from "effect/Effect";

import type {
  LoadedSourceCatalogToolIndexEntry,
} from "../catalog/source/runtime";
import {
  getSourceContribution,
} from "../sources/source-plugins";
import {
  runtimeEffectError,
} from "../effect-errors";

export const invocationDescriptorFromTool = (input: {
  tool: LoadedSourceCatalogToolIndexEntry;
}): {
  toolPath: string;
  sourceId: Source["id"];
  sourceName: Source["name"];
  sourceKind: Source["kind"];
  sourceNamespace: string | null;
  operationKind: "read" | "write" | "delete" | "execute" | "unknown";
  interaction: "auto" | "required";
  approvalLabel: string | null;
} => ({
  toolPath: input.tool.path,
  sourceId: input.tool.source.id,
  sourceName: input.tool.source.name,
  sourceKind: input.tool.source.kind,
  sourceNamespace: input.tool.source.namespace ?? null,
  operationKind:
    input.tool.capability.semantics.effect === "read"
      ? "read"
      : input.tool.capability.semantics.effect === "write"
        ? "write"
        : input.tool.capability.semantics.effect === "delete"
          ? "delete"
          : input.tool.capability.semantics.effect === "action"
            ? "execute"
            : "unknown",
  interaction: input.tool.descriptor.interaction ?? "auto",
  approvalLabel: input.tool.capability.surface.title ?? input.tool.executable.display?.title ?? null,
});

export const invokeIrTool = (input: {
  scopeId: Source["scopeId"];
  actorScopeId: ScopeId;
  tool: LoadedSourceCatalogToolIndexEntry;
  args: unknown;
  onElicitation?: OnElicitation;
  context?: Record<string, unknown>;
}) => {
  const definition = getSourceContribution(input.tool.executable.pluginKey);
  if (definition.kind !== input.tool.source.kind) {
    return Effect.fail(
      runtimeEffectError("execution/ir-execution", 
        `Executable ${input.tool.executable.id} expects source type ${definition.kind}, but source ${input.tool.source.id} is ${input.tool.source.kind}`,
      ),
    );
  }

  return definition.invoke({
    source: input.tool.source,
    capability: input.tool.capability,
    executable: input.tool.executable,
    descriptor: input.tool.descriptor,
    catalog: input.tool.projectedCatalog,
    args: input.args,
    onElicitation: input.onElicitation,
    context: input.context,
  });
};

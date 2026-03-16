import { type ToolPath, makeToolInvokerFromTools } from "@executor/codemode-core";
import type { Source } from "#schema";
import * as Either from "effect/Either";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { LoadedSourceCatalogToolIndexEntry } from "../catalog/source-catalog-runtime";
import type { SecretMaterialResolveContext } from "../local/secret-material-providers";
import type { WorkspaceStorageServices } from "../local/local-storage";
import { invocationDescriptorFromTool } from "./ir-execution";
import { evaluateInvocationPolicy } from "../policy/invocation-policy-engine";
import { loadRuntimeLocalWorkspacePolicies } from "../policy/policies-operations";

const asToolPath = (value: string): ToolPath => value as ToolPath;

const approvalSchema = {
  type: "object",
  properties: {
    approve: {
      type: "boolean",
      description: "Whether to approve this tool execution",
    },
  },
  required: ["approve"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

const approvalMessageForInvocation = (
  descriptor: ReturnType<typeof invocationDescriptorFromTool>,
): string => {
  if (descriptor.approvalLabel) {
    return `Allow ${descriptor.approvalLabel}?`;
  }

  return `Allow tool call: ${descriptor.toolPath}?`;
};

const SecretResolutionContextEnvelopeSchema = Schema.Struct({
  params: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
});

const decodeSecretResolutionContextEnvelope = Schema.decodeUnknownEither(
  SecretResolutionContextEnvelopeSchema,
);

export const toSecretResolutionContext = (
  value: unknown,
): SecretMaterialResolveContext | undefined => {
  const decoded = decodeSecretResolutionContextEnvelope(value);
  if (Either.isLeft(decoded) || decoded.right.params === undefined) {
    return undefined;
  }

  return {
    params: decoded.right.params,
  };
};

type WorkspaceToolElicitation = Parameters<
  typeof makeToolInvokerFromTools
>[0]["onElicitation"];

export const authorizePersistedToolInvocation = (input: {
  workspaceId: Source["workspaceId"];
  tool: LoadedSourceCatalogToolIndexEntry;
  args: unknown;
  context?: Record<string, unknown>;
  onElicitation?: WorkspaceToolElicitation;
}): Effect.Effect<void, Error, WorkspaceStorageServices> =>
  Effect.gen(function* () {
    const descriptor = invocationDescriptorFromTool({
      tool: input.tool,
    });
    const localWorkspacePolicies = yield* loadRuntimeLocalWorkspacePolicies(
      input.workspaceId,
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );

    const decision = evaluateInvocationPolicy({
      descriptor,
      args: input.args,
      policies: localWorkspacePolicies.policies,
      context: {
        workspaceId: input.workspaceId,
      },
    });

    if (decision.kind === "allow") {
      return;
    }

    if (decision.kind === "deny") {
      return yield* Effect.fail(new Error(decision.reason));
    }

    if (!input.onElicitation) {
      return yield* Effect.fail(
        new Error(
          `Approval required for ${descriptor.toolPath}, but no elicitation-capable host is available`,
        ),
      );
    }

    const interactionId =
      typeof input.context?.callId === "string" &&
      input.context.callId.length > 0
        ? `tool_execution_gate:${input.context.callId}`
        : `tool_execution_gate:${crypto.randomUUID()}`;
    const response = yield* input
      .onElicitation({
        interactionId,
        path: asToolPath(descriptor.toolPath),
        sourceKey: input.tool.source.id,
        args: input.args,
        context: {
          ...(input.context ?? {}),
          interactionPurpose: "tool_execution_gate",
          interactionReason: decision.reason,
          invocationDescriptor: {
            operationKind: descriptor.operationKind,
            interaction: descriptor.interaction,
            approvalLabel: descriptor.approvalLabel,
            sourceId: input.tool.source.id,
            sourceName: input.tool.source.name,
          },
        },
        elicitation: {
          mode: "form",
          message: approvalMessageForInvocation(descriptor),
          requestedSchema: approvalSchema,
        },
      })
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      );

    if (response.action !== "accept") {
      return yield* Effect.fail(
        new Error(
          `Tool invocation not approved for ${descriptor.toolPath}`,
        ),
      );
    }
  });

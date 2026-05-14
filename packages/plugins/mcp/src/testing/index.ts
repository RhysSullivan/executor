import {
  ScopeId,
  type CredentialBindingsFacade,
  type CredentialBindingValue,
} from "@executor-js/sdk";

export { serveMcpServer, type McpTestServer } from "./server";

type ScopeInput = ScopeId | string;

const scopeId = (scope: ScopeInput): ScopeId => ScopeId.make(String(scope));

export interface McpTestCredentialBindingInput {
  readonly sourceId: string;
  readonly sourceScope: ScopeInput;
  readonly targetScope: ScopeInput;
  readonly slotKey: string;
  readonly value: CredentialBindingValue;
}

export const setMcpCredentialBinding = (
  executor: { readonly credentialBindings: CredentialBindingsFacade },
  input: McpTestCredentialBindingInput,
): ReturnType<CredentialBindingsFacade["set"]> =>
  executor.credentialBindings.set({
    targetScope: scopeId(input.targetScope),
    pluginId: "mcp",
    sourceId: input.sourceId,
    sourceScope: scopeId(input.sourceScope),
    slotKey: input.slotKey,
    value: input.value,
  });

export const listMcpCredentialBindings = (
  executor: { readonly credentialBindings: CredentialBindingsFacade },
  input: { readonly sourceId: string; readonly sourceScope: ScopeInput },
): ReturnType<CredentialBindingsFacade["listForSource"]> =>
  executor.credentialBindings.listForSource({
    pluginId: "mcp",
    sourceId: input.sourceId,
    sourceScope: scopeId(input.sourceScope),
  });

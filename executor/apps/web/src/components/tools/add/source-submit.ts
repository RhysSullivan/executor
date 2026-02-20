import type {
  AnonymousContext,
  CredentialRecord,
  CredentialScope,
  SourceAuthType,
  ToolSourceScopeType,
  ToolSourceRecord,
} from "@/lib/types";
import { createCustomSourceConfig, type SourceType } from "./source/dialog-helpers";
import { existingCredentialMatchesAuthType } from "./source/form-utils";

type UpsertToolSourceFn = (args: {
  id?: ToolSourceRecord["id"];
  workspaceId: AnonymousContext["workspaceId"];
  sessionId: AnonymousContext["sessionId"];
  scopeType?: ToolSourceScopeType;
  name: string;
  type: SourceType;
  config: Record<string, unknown>;
  credential?: {
    id?: CredentialRecord["id"];
    scopeType?: CredentialScope;
    accountId?: AnonymousContext["accountId"];
    secretJson: Record<string, unknown>;
  };
}) => Promise<unknown>;

type SaveFormSnapshot = {
  name: string;
  endpoint: string;
  type: SourceType;
  scopeType: ToolSourceScopeType;
  baseUrl: string;
  mcpTransport: "auto" | "streamable-http" | "sse";
  authType: Exclude<SourceAuthType, "mixed">;
  authScope: CredentialScope;
  apiKeyHeader: string;
  existingScopedCredential: CredentialRecord | null;
  buildAuthConfig: () => Record<string, unknown> | undefined;
  hasCredentialInput: () => boolean;
  buildSecretJson: () => { value?: Record<string, unknown>; error?: string };
};

function credentialScopeTypeForAuthScope(
  authScope: CredentialScope,
  toolSourceScopeType: ToolSourceScopeType,
): CredentialScope {
  if (authScope === "account") {
    return "account";
  }

  return toolSourceScopeType === "organization" ? "organization" : "workspace";
}

export async function saveSourceWithCredentials({
  context,
  sourceToEdit,
  form,
  credentialsLoading,
  upsertToolSource,
}: {
  context: AnonymousContext;
  sourceToEdit?: ToolSourceRecord;
  form: SaveFormSnapshot;
  credentialsLoading: boolean;
  upsertToolSource: UpsertToolSourceFn;
}): Promise<{ source: ToolSourceRecord; connected: boolean }> {
  const authConfig = form.type === "openapi" || form.type === "graphql" || form.type === "mcp"
    ? form.buildAuthConfig()
    : undefined;

  let linkedCredential = false;
  let credentialPayload:
    | {
      id?: CredentialRecord["id"];
      scopeType: CredentialScope;
      accountId?: AnonymousContext["accountId"];
      secretJson: Record<string, unknown>;
    }
    | undefined;

  if ((form.type === "openapi" || form.type === "graphql" || form.type === "mcp") && form.authType !== "none") {
    const credentialScopeType = credentialScopeTypeForAuthScope(form.authScope, form.scopeType);

    if (form.authScope === "account" && !context.accountId) {
      throw new Error("Account credentials require an authenticated account");
    }

    const enteredCredential = form.hasCredentialInput();
    if (!enteredCredential && credentialsLoading) {
      throw new Error("Loading existing connections, try again in a moment");
    }

    if (enteredCredential) {
      const secret = form.buildSecretJson();
      if (!secret.value) {
        throw new Error(secret.error ?? "Credential values are required");
      }

      credentialPayload = {
        ...(form.existingScopedCredential ? { id: form.existingScopedCredential.id } : {}),
        scopeType: credentialScopeType,
        ...(credentialScopeType === "account" ? { accountId: context.accountId } : {}),
        secretJson: secret.value,
      };
      linkedCredential = true;
    } else if (form.existingScopedCredential) {
      if (!existingCredentialMatchesAuthType(form.existingScopedCredential, form.authType)) {
        linkedCredential = false;
      } else {
        linkedCredential = true;
      }
    } else {
      linkedCredential = false;
    }
  }

  const config = createCustomSourceConfig({
    type: form.type,
    endpoint: form.endpoint.trim(),
    baseUrl: form.baseUrl,
    auth: authConfig,
    mcpTransport: form.mcpTransport,
    accountId: context.accountId,
  });

  const created = await upsertToolSource({
    ...(sourceToEdit ? { id: sourceToEdit.id } : {}),
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
    scopeType: form.scopeType,
    name: form.name.trim(),
    type: form.type,
    config,
    ...(credentialPayload ? { credential: credentialPayload } : {}),
  }) as ToolSourceRecord;

  return {
    source: created,
    connected: linkedCredential,
  };
}

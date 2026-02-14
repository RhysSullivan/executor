import { sourceKeyForSource } from "@/lib/tools-source-helpers";
import type {
  AnonymousContext,
  CredentialRecord,
  CredentialScope,
  SourceAuthType,
  ToolSourceRecord,
} from "@/lib/types";
import { createCustomSourceConfig, type SourceType } from "./add-source-dialog-helpers";
import { existingCredentialMatchesAuthType } from "./add-source-form-utils";

type UpsertToolSourceFn = (args: {
  id?: ToolSourceRecord["id"];
  workspaceId: AnonymousContext["workspaceId"];
  sessionId: AnonymousContext["sessionId"];
  name: string;
  type: SourceType;
  config: Record<string, unknown>;
}) => Promise<unknown>;

type UpsertCredentialFn = (args: {
  id?: CredentialRecord["id"];
  workspaceId: AnonymousContext["workspaceId"];
  sessionId: AnonymousContext["sessionId"];
  sourceKey: string;
  scope: CredentialScope;
  actorId?: AnonymousContext["actorId"];
  secretJson: Record<string, unknown>;
}) => Promise<unknown>;

type SaveFormSnapshot = {
  name: string;
  endpoint: string;
  type: SourceType;
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

function readLegacyMcpStaticSecret(
  sourceToEdit: ToolSourceRecord | undefined,
  authType: Exclude<SourceAuthType, "mixed">,
): Record<string, unknown> | null {
  if (sourceToEdit?.type !== "mcp") {
    return null;
  }

  const auth = sourceToEdit.config.auth as Record<string, unknown> | undefined;
  if (!auth || auth.mode !== "static" || auth.type !== authType) {
    return null;
  }

  if (authType === "bearer") {
    const token = typeof auth.token === "string" ? auth.token.trim() : "";
    return token ? { token } : null;
  }

  if (authType === "apiKey") {
    const value = typeof auth.value === "string" ? auth.value.trim() : "";
    return value ? { value } : null;
  }

  if (authType === "basic") {
    const username = typeof auth.username === "string" ? auth.username.trim() : "";
    const password = typeof auth.password === "string" ? auth.password.trim() : "";
    return username && password ? { username, password } : null;
  }

  return null;
}

export async function saveSourceWithCredentials({
  context,
  sourceToEdit,
  form,
  credentialsLoading,
  upsertToolSource,
  upsertCredential,
}: {
  context: AnonymousContext;
  sourceToEdit?: ToolSourceRecord;
  form: SaveFormSnapshot;
  credentialsLoading: boolean;
  upsertToolSource: UpsertToolSourceFn;
  upsertCredential: UpsertCredentialFn;
}): Promise<{ source: ToolSourceRecord; connected: boolean }> {
  const authConfig = form.type === "openapi" || form.type === "graphql" || form.type === "mcp"
    ? form.buildAuthConfig()
    : undefined;

  const config = createCustomSourceConfig({
    type: form.type,
    endpoint: form.endpoint.trim(),
    baseUrl: form.baseUrl,
    auth: authConfig,
    mcpTransport: form.mcpTransport,
    actorId: context.actorId,
  });

  const created = await upsertToolSource({
    ...(sourceToEdit ? { id: sourceToEdit.id } : {}),
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
    name: form.name.trim(),
    type: form.type,
    config,
  }) as ToolSourceRecord;

  let linkedCredential = false;

  if ((form.type === "openapi" || form.type === "graphql" || form.type === "mcp") && form.authType !== "none") {
    const sourceKey = sourceKeyForSource(created);
    if (!sourceKey) {
      throw new Error("Failed to resolve source key for credentials");
    }

    if (form.authScope === "actor" && !context.actorId) {
      throw new Error("Actor credentials require an authenticated actor");
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

      await upsertCredential({
        ...(form.existingScopedCredential ? { id: form.existingScopedCredential.id } : {}),
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        sourceKey,
        scope: form.authScope,
        ...(form.authScope === "actor" ? { actorId: context.actorId } : {}),
        secretJson: secret.value,
      });
      linkedCredential = true;
    } else if (form.existingScopedCredential) {
      if (!existingCredentialMatchesAuthType(form.existingScopedCredential, form.authType)) {
        throw new Error("Enter credentials for the selected auth type");
      }
      linkedCredential = true;
    } else if (form.type === "mcp") {
      const legacySecret = readLegacyMcpStaticSecret(sourceToEdit, form.authType);
      if (!legacySecret) {
        throw new Error("Enter credentials to finish setup");
      }

      await upsertCredential({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        sourceKey,
        scope: form.authScope,
        ...(form.authScope === "actor" ? { actorId: context.actorId } : {}),
        secretJson: legacySecret,
      });
      linkedCredential = true;
    } else {
      throw new Error("Enter credentials to finish setup");
    }
  }

  return {
    source: created,
    connected: linkedCredential,
  };
}

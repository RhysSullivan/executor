import { useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";
import {
  mcpSourceAtom,
  mcpSourceBindingsAtom,
  setMcpSourceBinding,
  updateMcpSource,
} from "./atoms";
import { connectionsAtom } from "@executor-js/react/api/atoms";
import { messageFromExit } from "@executor-js/react/api/error-reporting";
import { useScope, useScopeStack } from "@executor-js/react/api/scope-context";
import { connectionWriteKeys, sourceWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { slugifyNamespace, useSourceIdentity } from "@executor-js/react/plugins/source-identity";
import { useCredentialTargetScope } from "@executor-js/react/plugins/credential-target-scope";
import { useSecretPickerSecrets } from "@executor-js/react/plugins/use-secret-picker-secrets";
import {
  HttpCredentialsEditor,
  serializeHttpCredentials,
  serializeScopedHttpCredentials,
  type HttpCredentialsState,
} from "@executor-js/react/plugins/http-credentials";
import {
  effectiveCredentialBindingForScope,
  httpCredentialsFromConfiguredCredentialBindings,
  initialCredentialTargetScope,
} from "@executor-js/react/plugins/credential-bindings";
import { SourceOAuthConnectionControl } from "@executor-js/react/plugins/source-oauth-connection";
import { Button } from "@executor-js/react/components/button";
import { Badge } from "@executor-js/react/components/badge";
import { ScopeId } from "@executor-js/sdk/shared";
import { McpRemoteSourceFields } from "./McpRemoteSourceFields";
import { McpStdioSourceFields } from "./McpStdioSourceFields";
import {
  formatStdioArgs,
  formatStdioEnv,
  parseStdioArgs,
  parseStdioEnv,
} from "./stdio-form-helpers";
import {
  McpSourceBindingInput,
  type McpCredentialInput,
  type McpSourceBindingRef,
} from "../sdk/types";
import type { McpStoredSourceSchemaType } from "../sdk/stored-source";

// ---------------------------------------------------------------------------
// Remote edit form
// ---------------------------------------------------------------------------

function RemoteEditForm(props: {
  sourceId: string;
  initial: McpStoredSourceSchemaType & { config: { transport: "remote" } };
  bindings: readonly McpSourceBindingRef[];
  onSave: () => void;
}) {
  const displayScope = useScope();
  const scopeStack = useScopeStack();
  const sourceScope = ScopeId.make(props.initial.scope);
  const { credentialTargetScope, credentialScopeOptions } = useCredentialTargetScope({
    sourceScope,
    initialTargetScope: initialCredentialTargetScope(sourceScope, props.bindings),
  });
  const {
    credentialTargetScope: oauthCredentialTargetScope,
    setCredentialTargetScope: setOAuthCredentialTargetScope,
  } = useCredentialTargetScope({
    sourceScope,
    initialTargetScope: initialCredentialTargetScope(sourceScope, props.bindings),
  });
  const doUpdate = useAtomSet(updateMcpSource, { mode: "promiseExit" });
  const setBinding = useAtomSet(setMcpSourceBinding, { mode: "promise" });
  const secretList = useSecretPickerSecrets();
  const connectionsResult = useAtomValue(connectionsAtom(displayScope));

  const identity = useSourceIdentity({
    fallbackName: props.initial.name,
    fallbackNamespace: props.initial.namespace,
  });
  const [endpoint, setEndpoint] = useState(props.initial.config.endpoint);
  const [credentials, setCredentials] = useState<HttpCredentialsState>(() =>
    httpCredentialsFromConfiguredCredentialBindings({
      headers: props.initial.config.headers,
      queryParams: props.initial.config.queryParams,
      bindings: props.bindings,
    }),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentialsDirty, setCredentialsDirty] = useState(false);

  const identityDirty = identity.name.trim() !== props.initial.name.trim();
  const metadataDirty = identityDirty || endpoint.trim() !== props.initial.config.endpoint.trim();
  const dirty = metadataDirty || credentialsDirty;
  const oauth2 = props.initial.config.auth.kind === "oauth2" ? props.initial.config.auth : null;
  const connections = AsyncResult.isSuccess(connectionsResult) ? connectionsResult.value : [];
  const scopeRanks = new Map(scopeStack.map((scope, index) => [scope.id, index] as const));
  const connectionBinding = oauth2
    ? effectiveCredentialBindingForScope(
        props.bindings,
        oauth2.connectionSlot,
        oauthCredentialTargetScope,
        scopeRanks,
      )
    : null;
  const boundConnectionId =
    connectionBinding?.value.kind === "connection" ? connectionBinding.value.connectionId : null;
  const isConnected =
    boundConnectionId !== null &&
    connections.some((connection) => connection.id === boundConnectionId);
  const oauthRequestCredentials = serializeHttpCredentials(credentials);

  const handleCredentialsChange = (next: HttpCredentialsState) => {
    setCredentials(next);
    setCredentialsDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const { headers, queryParams } = serializeScopedHttpCredentials(
      credentials,
      credentialTargetScope,
    );
    const payload: {
      sourceScope: ScopeId;
      name?: string;
      endpoint?: string;
      headers?: Record<string, McpCredentialInput>;
      queryParams?: Record<string, McpCredentialInput>;
      credentialTargetScope?: ScopeId;
    } = {
      sourceScope,
      name: metadataDirty ? identity.name.trim() || undefined : undefined,
      endpoint: metadataDirty ? endpoint.trim() || undefined : undefined,
    };
    if (credentialsDirty) {
      payload.headers = headers;
      payload.queryParams = queryParams as Record<string, McpCredentialInput>;
      payload.credentialTargetScope = credentialTargetScope;
    }
    const exit = await doUpdate({
      params: { scopeId: displayScope, namespace: props.sourceId },
      payload,
      reactivityKeys: sourceWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setError("Failed to update source");
      setSaving(false);
      return;
    }
    setCredentialsDirty(false);
    setSaving(false);
    props.onSave();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Update the endpoint and headers for this MCP connection.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">{props.sourceId}</p>
        </div>
        <Badge variant="secondary" className="text-xs">
          remote
        </Badge>
      </div>

      <McpRemoteSourceFields
        url={endpoint}
        onUrlChange={setEndpoint}
        identity={identity}
        preview={{
          name: props.initial.name,
          serverName: props.initial.name,
          connected: true,
          toolCount: null,
        }}
        namespaceReadOnly
      />

      <HttpCredentialsEditor
        credentials={credentials}
        onChange={handleCredentialsChange}
        existingSecrets={secretList}
        sourceName={identity.name}
        targetScope={credentialTargetScope}
        credentialScopeOptions={credentialScopeOptions}
        bindingScopeOptions={credentialScopeOptions}
      />

      {oauth2 && (
        <SourceOAuthConnectionControl
          popupName="mcp-oauth"
          pluginId="mcp"
          namespace={slugifyNamespace(props.initial.namespace) || "mcp"}
          fallbackNamespace="mcp"
          endpoint={endpoint.trim()}
          tokenScope={oauthCredentialTargetScope}
          onTokenScopeChange={setOAuthCredentialTargetScope}
          credentialScopeOptions={credentialScopeOptions}
          connectionId={boundConnectionId}
          sourceLabel={`${identity.name.trim() || props.initial.namespace || "MCP"} OAuth`}
          headers={oauthRequestCredentials.headers}
          queryParams={oauthRequestCredentials.queryParams}
          isConnected={isConnected}
          onConnected={async (connectionId) => {
            await setBinding({
              params: { scopeId: oauthCredentialTargetScope },
              payload: McpSourceBindingInput.make({
                sourceId: props.sourceId,
                sourceScope,
                scope: oauthCredentialTargetScope,
                slot: oauth2.connectionSlot,
                value: { kind: "connection", connectionId },
              }),
              reactivityKeys: [...sourceWriteKeys, ...connectionWriteKeys],
            });
          }}
          reconnectingLabel="Reconnecting…"
          signingInLabel="Signing in…"
        />
      )}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onClick={props.onSave}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stdio edit form
// ---------------------------------------------------------------------------

function StdioEditForm(props: {
  sourceId: string;
  initial: McpStoredSourceSchemaType & { config: { transport: "stdio" } };
  onSave: () => void;
}) {
  const displayScope = useScope();
  const doUpdate = useAtomSet(updateMcpSource, { mode: "promiseExit" });
  const sourceScope = ScopeId.make(props.initial.scope);

  const initialArgs = formatStdioArgs(props.initial.config.args);
  const initialEnv = formatStdioEnv(props.initial.config.env);
  const initialCwd = props.initial.config.cwd ?? "";

  const [command, setCommand] = useState(props.initial.config.command);
  const [args, setArgs] = useState(initialArgs);
  const [env, setEnv] = useState(initialEnv);
  const [cwd, setCwd] = useState(initialCwd);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedCommand = command.trim();
  const commandChanged = trimmedCommand !== props.initial.config.command.trim();
  const argsChanged = args !== initialArgs;
  const envChanged = env !== initialEnv;
  const cwdChanged = cwd !== initialCwd;
  const dirty = commandChanged || argsChanged || envChanged || cwdChanged;
  const canSave = Boolean(trimmedCommand) && dirty && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const exit = await doUpdate({
      params: { scopeId: displayScope, namespace: props.sourceId },
      payload: {
        sourceScope,
        ...(commandChanged ? { command: trimmedCommand } : {}),
        ...(argsChanged ? { args: parseStdioArgs(args) } : {}),
        ...(envChanged ? { env: parseStdioEnv(env) ?? {} } : {}),
        ...(cwdChanged ? { cwd: cwd.trim() } : {}),
      },
      reactivityKeys: sourceWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setError(messageFromExit(exit, "Failed to update source"));
      setSaving(false);
      return;
    }
    setSaving(false);
    props.onSave();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Update the command, arguments, and environment for this MCP server. Saving re-discovers
          the available tools.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">{props.sourceId}</p>
        </div>
        <Badge variant="secondary" className="text-xs">
          stdio
        </Badge>
      </div>

      <McpStdioSourceFields
        command={command}
        onCommandChange={setCommand}
        args={args}
        onArgsChange={setArgs}
        env={env}
        onEnvChange={setEnv}
        cwd={cwd}
        onCwdChange={setCwd}
      />

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="ghost" onClick={props.onSave} disabled={saving}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!canSave}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function EditMcpSource({
  sourceId,
  onSave,
}: {
  readonly sourceId: string;
  readonly onSave: () => void;
}) {
  const scopeId = useScope();
  const sourceResult = useAtomValue(mcpSourceAtom(scopeId, sourceId)) as AsyncResult.AsyncResult<
    McpStoredSourceSchemaType | null,
    unknown
  >;
  const source =
    AsyncResult.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const sourceScope = source ? ScopeId.make(source.scope) : scopeId;
  const bindingsResult = useAtomValue(mcpSourceBindingsAtom(scopeId, sourceId, sourceScope));

  if (!AsyncResult.isSuccess(sourceResult) || !source || !AsyncResult.isSuccess(bindingsResult)) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Edit MCP Source</h1>
          <p className="mt-1 text-sm text-muted-foreground">Loading configuration…</p>
        </div>
      </div>
    );
  }

  if (source.config.transport === "stdio") {
    return (
      <StdioEditForm
        sourceId={sourceId}
        initial={source as McpStoredSourceSchemaType & { config: { transport: "stdio" } }}
        onSave={onSave}
      />
    );
  }

  return (
    <RemoteEditForm
      sourceId={sourceId}
      initial={source as McpStoredSourceSchemaType & { config: { transport: "remote" } }}
      bindings={bindingsResult.value}
      onSave={onSave}
    />
  );
}

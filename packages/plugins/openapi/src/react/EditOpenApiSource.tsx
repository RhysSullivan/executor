import { useEffect, useMemo, useRef, useState } from "react";
import { Result, useAtomSet, useAtomValue } from "@effect-atom/atom-react";

import { openOAuthPopup, type OAuthPopupResult } from "@executor/plugin-oauth2/react";
import {
  connectionsAtom,
  sourceAtom,
} from "@executor/react/api/atoms";
import { useScope, useScopeStack, useUserScope } from "@executor/react/api/scope-context";
import {
  connectionWriteKeys,
  sourceWriteKeys,
} from "@executor/react/api/reactivity-keys";
import { Button } from "@executor/react/components/button";
import { CopyButton } from "@executor/react/components/copy-button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryField,
  CardStackEntryTitle,
} from "@executor/react/components/card-stack";
import { FilterTabs } from "@executor/react/components/filter-tabs";
import { Input } from "@executor/react/components/input";
import { sourceWriteKeys as openApiWriteKeys } from "@executor/react/api/reactivity-keys";
import { ConnectionId, ScopeId, SecretId } from "@executor/sdk";
import { CreatableSecretPicker } from "@executor/react/plugins/secret-header-auth";
import { useSecretPickerSecrets } from "@executor/react/plugins/use-secret-picker-secrets";

import {
  openApiSourceAtom,
  openApiSourceBindingsAtom,
  removeOpenApiSourceBinding,
  setOpenApiSourceBinding,
  startOpenApiOAuth,
  updateOpenApiSource,
} from "./atoms";
import {
  OPENAPI_OAUTH_CALLBACK_PATH,
  OPENAPI_OAUTH_CHANNEL,
  OPENAPI_OAUTH_POPUP_NAME,
  openApiOAuthConnectionId,
  resolveOAuthUrl,
} from "./AddOpenApiSource";
import { oauth2ClientSecretSlot } from "../sdk/store";
import type { OpenApiSourceBindingValue } from "../sdk/types";

type SlotDef =
  | {
      readonly kind: "secret";
      readonly slot: string;
      readonly label: string;
      readonly hint?: string;
    }
  | {
      readonly kind: "oauth2";
      readonly slot: string;
      readonly label: string;
    };

const slugify = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "default";

const bindingSecretId = (sourceId: string, slot: string, scopeId: string): string =>
  `source-binding-${slugify(sourceId)}-${slugify(slot)}-${slugify(scopeId)}`;

const effectiveClientSecretSlot = (oauth2: {
  readonly securitySchemeName: string;
  readonly clientSecretSlot: string | null;
}): string => oauth2.clientSecretSlot ?? oauth2ClientSecretSlot(oauth2.securitySchemeName);

const exactBindingForScope = (
  rows: readonly {
    readonly slot: string;
    readonly scopeId: ScopeId;
    readonly value: unknown;
  }[],
  slot: string,
  scopeId: ScopeId,
) => rows.find((row) => row.slot === slot && row.scopeId === scopeId) ?? null;

const scopeRank = (ranks: ReadonlyMap<string, number>, scopeId: ScopeId): number =>
  ranks.get(scopeId as string) ?? Number.MAX_SAFE_INTEGER;

const effectiveBindingForScope = (
  rows: readonly {
    readonly slot: string;
    readonly scopeId: ScopeId;
    readonly value: unknown;
  }[],
  slot: string,
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
) =>
  rows
    .filter(
      (row) =>
        row.slot === slot &&
        scopeRank(ranks, row.scopeId) >= scopeRank(ranks, targetScope),
    )
    .sort(
      (a, b) =>
        scopeRank(ranks, a.scopeId) -
        scopeRank(ranks, b.scopeId),
    )[0] ?? null;

const isSecretBindingValue = (
  value: unknown,
): value is Extract<OpenApiSourceBindingValue, { readonly kind: "secret" }> =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as { kind?: unknown }).kind === "secret" &&
  "secretId" in value;

const isConnectionBindingValue = (
  value: unknown,
): value is Extract<OpenApiSourceBindingValue, { readonly kind: "connection" }> =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  (value as { kind?: unknown }).kind === "connection" &&
  "connectionId" in value;

export default function EditOpenApiSource(props: {
  readonly sourceId: string;
  readonly onSave: () => void;
}) {
  const displayScope = useScope();
  const scopeStack = useScopeStack();
  const userScope = useUserScope();
  const sourceSummaryResult = useAtomValue(sourceAtom(props.sourceId, displayScope));
  const sourceSummary =
    Result.isSuccess(sourceSummaryResult) && sourceSummaryResult.value
      ? sourceSummaryResult.value
      : null;
  const sourceScopeId = sourceSummary?.scopeId ?? displayScope;
  const sourceScope = ScopeId.make(sourceScopeId);
  const scopeRanks = useMemo(
    () => new Map(scopeStack.map((scope, index) => [scope.id as string, index] as const)),
    [scopeStack],
  );

  const sourceResult = useAtomValue(openApiSourceAtom(sourceScope, props.sourceId));
  const bindingsResult = useAtomValue(
    openApiSourceBindingsAtom(displayScope, props.sourceId, sourceScope),
  );
  const connectionsResult = useAtomValue(connectionsAtom(displayScope));
  const secretList = useSecretPickerSecrets();

  const doUpdate = useAtomSet(updateOpenApiSource, { mode: "promise" });
  const doSetBinding = useAtomSet(setOpenApiSourceBinding, { mode: "promise" });
  const doRemoveBinding = useAtomSet(removeOpenApiSourceBinding, { mode: "promise" });
  const doStartOAuth = useAtomSet(startOpenApiOAuth, { mode: "promise" });

  const source =
    Result.isSuccess(sourceResult) && sourceResult.value ? sourceResult.value : null;
  const bindingRows =
    Result.isSuccess(bindingsResult) ? bindingsResult.value : [];
  const connections =
    Result.isSuccess(connectionsResult) ? connectionsResult.value : [];
  const oauth2RedirectUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${OPENAPI_OAUTH_CALLBACK_PATH}`
      : OPENAPI_OAUTH_CALLBACK_PATH;

  const [name, setName] = useState(source?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(source?.config.baseUrl ?? "");
  const [sourceSaveState, setSourceSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loadedSourceKey, setLoadedSourceKey] = useState<string | null>(null);
  const [selectedCredentialScope, setSelectedCredentialScope] = useState<string>(
    userScope !== sourceScopeId ? userScope : sourceScopeId,
  );
  const sourceSaveSeq = useRef(0);

  useEffect(() => {
    if (!source) return;
    const sourceKey = `${sourceScopeId}:${source.namespace}`;
    if (loadedSourceKey === sourceKey) return;
    setName(source.name);
    setBaseUrl(source.config.baseUrl ?? "");
    setSourceSaveState("idle");
    setLoadedSourceKey(sourceKey);
  }, [loadedSourceKey, source, sourceScopeId]);

  useEffect(() => {
    setSelectedCredentialScope(userScope !== sourceScopeId ? userScope : sourceScopeId);
  }, [sourceScopeId, userScope]);

  useEffect(() => {
    if (!source) return;
    const sourceKey = `${sourceScopeId}:${source.namespace}`;
    if (loadedSourceKey !== sourceKey) return;

    const nextName = name.trim();
    const nextBaseUrl = baseUrl.trim();
    const currentName = source.name;
    const currentBaseUrl = source.config.baseUrl ?? "";
    if ((nextName || currentName) === currentName && nextBaseUrl === currentBaseUrl) {
      return;
    }

    const timeout = window.setTimeout(() => {
      const seq = ++sourceSaveSeq.current;
      setSourceSaveState("saving");
      setError(null);
      void doUpdate({
        path: { scopeId: ScopeId.make(sourceScopeId), namespace: props.sourceId },
        payload: {
          name: nextName || undefined,
          baseUrl: nextBaseUrl || undefined,
          headers: source.config.headers,
          oauth2: source.config.oauth2,
        },
        reactivityKeys: openApiWriteKeys,
      })
        .then(() => {
          if (sourceSaveSeq.current !== seq) return;
          setSourceSaveState("saved");
          window.setTimeout(() => {
            if (sourceSaveSeq.current === seq) setSourceSaveState("idle");
          }, 1600);
        })
        .catch((e: unknown) => {
          if (sourceSaveSeq.current !== seq) return;
          setSourceSaveState("idle");
          setError(e instanceof Error ? e.message : "Failed to save source details");
        });
    }, 600);

    return () => window.clearTimeout(timeout);
  }, [
    baseUrl,
    doUpdate,
    loadedSourceKey,
    name,
    props.sourceId,
    source,
    sourceScopeId,
  ]);

  const secretSlots = useMemo(() => {
    if (!source) return [] as SlotDef[];
    const slots: SlotDef[] = [];
    for (const [headerName, value] of Object.entries(source.config.headers ?? {})) {
      if (typeof value === "string") continue;
      slots.push({
        kind: "secret",
        slot: value.slot,
        label: headerName,
        hint: value.prefix ? `Prefix: ${value.prefix}` : undefined,
      });
    }
    if (source.config.oauth2) {
      const clientSecretSlot = effectiveClientSecretSlot(source.config.oauth2);
      slots.push({
        kind: "secret",
        slot: source.config.oauth2.clientIdSlot,
        label: "Client ID",
      });
      slots.push({
        kind: "secret",
        slot: clientSecretSlot,
        label: "Client Secret",
        hint:
          source.config.oauth2.flow === "authorizationCode"
            ? "Optional for public PKCE clients"
            : undefined,
      });
      slots.push({
        kind: "oauth2",
        slot: source.config.oauth2.connectionSlot,
        label:
          source.config.oauth2.flow === "clientCredentials"
            ? "OAuth Client Credentials"
            : "OAuth Authorization Code",
      });
    }
    return slots;
  }, [source]);

  const credentialScopes = useMemo(() => {
    const entries = [{ scopeId: ScopeId.make(sourceScopeId), label: "Organization" }];
    if (userScope !== sourceScopeId) {
      entries.unshift({ scopeId: ScopeId.make(userScope), label: "Personal" });
    } else {
      entries[0] = { scopeId: ScopeId.make(sourceScopeId), label: "Credentials" };
    }
    return entries;
  }, [sourceScopeId, userScope]);
  const activeCredentialScope =
    credentialScopes.find((entry) => entry.scopeId === selectedCredentialScope) ??
    credentialScopes[0]!;
  const activeCredentialScopeId = activeCredentialScope.scopeId;
  const activeCredentialScopeLabel = activeCredentialScope.label;

  if (!source) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold text-foreground">Edit OpenAPI Source</h1>
        <p className="text-sm text-muted-foreground">Loading configuration…</p>
      </div>
    );
  }

  const setSecretBinding = async (
    targetScope: ScopeId,
    slot: string,
    secretId: string,
  ) => {
    const inputKey = `${targetScope}:${slot}`;
    const trimmed = secretId.trim();
    if (!trimmed) return;
    setBusyKey(inputKey);
    setError(null);
    try {
      await doSetBinding({
        path: { scopeId: displayScope },
        payload: {
          sourceId: props.sourceId,
          sourceScope,
          scope: targetScope,
          slot,
          value: { kind: "secret", secretId: SecretId.make(trimmed) },
        },
        reactivityKeys: sourceWriteKeys,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save credential binding");
    } finally {
      setBusyKey(null);
    }
  };

  const clearBinding = async (targetScope: ScopeId, slot: string) => {
    setBusyKey(`${targetScope}:${slot}:clear`);
    setError(null);
    try {
      await doRemoveBinding({
        path: { scopeId: displayScope },
        payload: {
          sourceId: props.sourceId,
          sourceScope,
          slot,
          scope: targetScope,
        },
        reactivityKeys: sourceWriteKeys,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to clear credential binding");
    } finally {
      setBusyKey(null);
    }
  };

  const connectOAuth = async (targetScope: ScopeId) => {
    const oauth2 = source.config.oauth2;
    if (!oauth2) return;
    const clientIdBinding = effectiveBindingForScope(
      bindingRows,
      oauth2.clientIdSlot,
      targetScope,
      scopeRanks,
    );
    const clientSecretSlot = effectiveClientSecretSlot(oauth2);
    const clientSecretBinding = effectiveBindingForScope(
      bindingRows,
      clientSecretSlot,
      targetScope,
      scopeRanks,
    );
    if (!clientIdBinding || !isSecretBindingValue(clientIdBinding.value)) {
      setError("Client ID must be bound before connecting");
      return;
    }
    if (oauth2.flow === "clientCredentials" && (!clientSecretBinding || !isSecretBindingValue(clientSecretBinding.value))) {
      setError("Client secret must be bound before connecting");
      return;
    }
    const clientSecretValue =
      oauth2.flow === "clientCredentials" &&
      clientSecretBinding &&
      isSecretBindingValue(clientSecretBinding.value)
        ? clientSecretBinding.value
        : null;

    const existingConnection = exactBindingForScope(
      bindingRows,
      oauth2.connectionSlot,
      targetScope,
    );
    const connectionId =
      existingConnection && isConnectionBindingValue(existingConnection.value)
        ? existingConnection.value.connectionId
        : ConnectionId.make(openApiOAuthConnectionId(props.sourceId, oauth2.flow));

    setBusyKey(`${targetScope}:${oauth2.connectionSlot}:connect`);
    setError(null);
    try {
      const displayName = source.name;
      const tokenUrl = resolveOAuthUrl(oauth2.tokenUrl, source.config.baseUrl ?? "");
      if (oauth2.flow === "clientCredentials") {
        const response = await doStartOAuth({
          path: { scopeId: displayScope },
          payload: {
            sourceId: props.sourceId,
            connectionId,
            tokenScope: targetScope,
            displayName,
            securitySchemeName: oauth2.securitySchemeName,
            flow: "clientCredentials",
            tokenUrl,
            clientIdSecretId: clientIdBinding.value.secretId,
            clientSecretSecretId: clientSecretValue!.secretId,
            scopes: [...oauth2.scopes],
          },
        });
        if (response.flow !== "clientCredentials") {
          throw new Error("Unexpected OAuth response");
        }
        await doSetBinding({
          path: { scopeId: displayScope },
          payload: {
            sourceId: props.sourceId,
            sourceScope,
            scope: targetScope,
            slot: oauth2.connectionSlot,
            value: {
              kind: "connection",
              connectionId: ConnectionId.make(response.auth.connectionId),
            },
          },
          reactivityKeys: [...sourceWriteKeys, ...connectionWriteKeys],
        });
        setBusyKey(null);
        return;
      }

      const authorizationUrl = resolveOAuthUrl(
        oauth2.authorizationUrl ?? "",
        source.config.baseUrl ?? "",
      );
      const redirectUrl =
        typeof window !== "undefined"
          ? `${window.location.origin}${OPENAPI_OAUTH_CALLBACK_PATH}`
          : OPENAPI_OAUTH_CALLBACK_PATH;
      const response = await doStartOAuth({
        path: { scopeId: displayScope },
        payload: {
          sourceId: props.sourceId,
          connectionId,
          tokenScope: targetScope,
          displayName,
          securitySchemeName: oauth2.securitySchemeName,
          flow: "authorizationCode",
          authorizationUrl,
          tokenUrl,
          redirectUrl,
          clientIdSecretId: clientIdBinding.value.secretId,
          clientSecretSecretId:
            clientSecretBinding && isSecretBindingValue(clientSecretBinding.value)
              ? clientSecretBinding.value.secretId
              : undefined,
          scopes: [...oauth2.scopes],
        },
      });
      if (response.flow !== "authorizationCode") {
        throw new Error("Unexpected OAuth response");
      }
      openOAuthPopup({
        url: response.authorizationUrl,
        popupName: OPENAPI_OAUTH_POPUP_NAME,
        channelName: OPENAPI_OAUTH_CHANNEL,
        onResult: async (result: OAuthPopupResult<{ connectionId: string }>) => {
          if (!result.ok) {
            setError(result.error);
            setBusyKey(null);
            return;
          }
          try {
            await doSetBinding({
              path: { scopeId: displayScope },
              payload: {
                sourceId: props.sourceId,
                sourceScope,
                scope: targetScope,
                slot: oauth2.connectionSlot,
                value: {
                  kind: "connection",
                  connectionId: ConnectionId.make(result.connectionId),
                },
              },
              reactivityKeys: [...sourceWriteKeys, ...connectionWriteKeys],
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to save OAuth binding");
          } finally {
            setBusyKey(null);
          }
        },
        onClosed: () => {
          setBusyKey(null);
        },
        onOpenFailed: () => {
          setError("OAuth popup was blocked by the browser");
          setBusyKey(null);
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect OAuth");
      setBusyKey(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">OpenAPI Source</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Shared source settings stay on the source. Credentials can be saved
          personally or shared with the organization.
        </p>
      </div>

      <CardStack>
        <CardStackContent className="border-t-0">
          <CardStackEntry>
            <CardStackEntryContent>
              <CardStackEntryTitle>Source Details</CardStackEntryTitle>
              <CardStackEntryDescription>
                Name and base URL save automatically.
              </CardStackEntryDescription>
            </CardStackEntryContent>
            {sourceSaveState !== "idle" && (
              <span className="text-xs text-muted-foreground">
                {sourceSaveState === "saving" ? "Saving…" : "Saved"}
              </span>
            )}
          </CardStackEntry>
          <CardStackEntryField label="Name">
            <Input value={name} onChange={(e) => setName((e.target as HTMLInputElement).value)} />
          </CardStackEntryField>
          <CardStackEntryField label="Base URL">
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
              className="font-mono text-sm"
            />
          </CardStackEntryField>
          <CardStackEntry>
            <CardStackEntryContent>
              <CardStackEntryTitle>Authentication Template</CardStackEntryTitle>
              <CardStackEntryDescription>
                {source.config.oauth2
                  ? `OAuth2 ${source.config.oauth2.flow}`
                  : Object.keys(source.config.headers ?? {}).length > 0
                    ? `${Object.keys(source.config.headers ?? {}).length} header binding${
                        Object.keys(source.config.headers ?? {}).length === 1 ? "" : "s"
                      }`
                    : "None"}
              </CardStackEntryDescription>
            </CardStackEntryContent>
          </CardStackEntry>
        </CardStackContent>
      </CardStack>

      <CardStack>
        <CardStackContent className="border-t-0">
          {credentialScopes.length > 1 && (
            <CardStackEntry>
              <CardStackEntryContent>
                <CardStackEntryTitle>Credentials</CardStackEntryTitle>
                <CardStackEntryDescription>
                  Choose whether each credential is personal or shared with the
                  organization.
                </CardStackEntryDescription>
              </CardStackEntryContent>
              <FilterTabs
                tabs={credentialScopes.map((entry) => ({
                  value: entry.scopeId as string,
                  label: entry.label,
                }))}
                value={activeCredentialScopeId as string}
                onChange={setSelectedCredentialScope}
              />
            </CardStackEntry>
          )}

          {secretSlots
            .filter((slot) => slot.kind === "secret")
            .map((slot) => {
              const exact = exactBindingForScope(
                bindingRows,
                slot.slot,
                activeCredentialScopeId,
              );
              const effective = effectiveBindingForScope(
                bindingRows,
                slot.slot,
                activeCredentialScopeId,
                scopeRanks,
              );
              const inputKey = `${activeCredentialScopeId}:${slot.slot}`;
              const savedHere = !!(exact && isSecretBindingValue(exact.value));
              const inherited =
                !savedHere &&
                effective &&
                effective.scopeId !== activeCredentialScopeId &&
                isSecretBindingValue(effective.value);
              const currentSecretId =
                exact && isSecretBindingValue(exact.value)
                  ? (exact.value.secretId as string)
                  : inherited && effective && isSecretBindingValue(effective.value)
                    ? (effective.value.secretId as string)
                    : null;
              return (
                <CardStackEntryField key={`${slot.slot}:${activeCredentialScopeId}`} label={slot.label}>
                  <div className="space-y-2">
                    <CreatableSecretPicker
                      value={currentSecretId}
                      onSelect={(secretId) =>
                        void setSecretBinding(activeCredentialScopeId, slot.slot, secretId)
                      }
                      secrets={secretList}
                      placeholder={
                        savedHere
                          ? `Selected in ${activeCredentialScopeLabel.toLowerCase()}`
                          : inherited
                            ? "Using organization default"
                            : "Select or create a secret"
                      }
                      targetScope={activeCredentialScopeId}
                      suggestedId={bindingSecretId(
                        props.sourceId,
                        slot.slot,
                        activeCredentialScopeId,
                      )}
                      sourceName={source.name}
                      secretLabel={slot.label}
                    />
                    <div className="flex items-center gap-2">
                      {savedHere && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void clearBinding(activeCredentialScopeId, slot.slot)}
                          disabled={
                            busyKey === `${activeCredentialScopeId}:${slot.slot}:clear`
                          }
                        >
                          Clear
                        </Button>
                      )}
                      {busyKey === inputKey && (
                        <span className="text-xs text-muted-foreground">Saving…</span>
                      )}
                      {slot.hint && (
                        <span className="text-xs text-muted-foreground">{slot.hint}</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {savedHere
                        ? `Saved in ${activeCredentialScopeLabel.toLowerCase()}.`
                        : inherited
                          ? "No value saved here. Using the organization default."
                          : `No ${activeCredentialScopeLabel.toLowerCase()} value saved yet.`}
                    </p>
                  </div>
                </CardStackEntryField>
              );
            })}

          {source.config.oauth2 && (
            <>
              <CardStackEntryField label="Redirect URL">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1 rounded-md border border-border bg-background/50 px-2.5 py-1.5 font-mono text-[11px]">
                    <span className="truncate flex-1 text-foreground">{oauth2RedirectUrl}</span>
                    <CopyButton value={oauth2RedirectUrl} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Add this to your OAuth app&apos;s allowed redirects.
                  </p>
                </div>
              </CardStackEntryField>
              <CardStackEntryField label="OAuth Connection">
                {(() => {
                  const exact = exactBindingForScope(
                    bindingRows,
                    source.config.oauth2!.connectionSlot,
                    activeCredentialScopeId,
                  );
                  const binding =
                    exact ??
                    effectiveBindingForScope(
                      bindingRows,
                      source.config.oauth2!.connectionSlot,
                      activeCredentialScopeId,
                      scopeRanks,
                    );
                  const connectionBinding =
                    binding && isConnectionBindingValue(binding.value)
                      ? binding.value
                      : null;
                  const connection = connectionBinding
                    ? connections.find((entry) => entry.id === connectionBinding.connectionId)
                    : null;
                  const bindingScopeId = connectionBinding && binding ? binding.scopeId : null;
                  const isConnecting =
                    busyKey ===
                    `${activeCredentialScopeId}:${source.config.oauth2.connectionSlot}:connect`;
                  const isConnected = connection !== null && connection !== undefined;
                  const statusText =
                    connectionBinding && bindingScopeId
                      ? connection
                        ? bindingScopeId === activeCredentialScopeId
                          ? `Connected in ${activeCredentialScopeLabel.toLowerCase()} as ${
                              connection.identityLabel ?? connection.id
                            }`
                          : `Using organization connection ${
                              connection.identityLabel ?? connection.id
                            }`
                        : bindingScopeId === activeCredentialScopeId
                          ? `Connection saved in ${activeCredentialScopeLabel.toLowerCase()}`
                          : "Using organization connection"
                      : `No ${activeCredentialScopeLabel.toLowerCase()} connection`;

                  return (
                    <div className="space-y-2">
                      <div className="text-sm text-muted-foreground">{statusText}</div>
                      <Button
                        size="sm"
                        onClick={() => void connectOAuth(activeCredentialScopeId)}
                        disabled={isConnecting}
                      >
                        {isConnecting ? "Connecting…" : isConnected ? "Reconnect" : "Connect"}
                      </Button>
                    </div>
                  );
                })()}
              </CardStackEntryField>
            </>
          )}
        </CardStackContent>
      </CardStack>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex items-center justify-start border-t border-border pt-4">
        <Button variant="ghost" onClick={props.onSave}>
          Back
        </Button>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useReducer } from "react";
import type {
  CredentialRecord,
  CredentialScope,
  OwnerScopeType,
  SourceAuthProfile,
  ToolSourceRecord,
} from "@/lib/types";
import {
  formatHeaderOverrides,
  sourceAuthForKey,
} from "@/lib/credentials/source-helpers";
import {
  buildConnectionOptions,
  buildSourceOptions,
  compatibleConnections,
  selectedAuthBadge,
  type ConnectionMode,
} from "./dialog-state";

type UseConnectionFormDialogFormParams = {
  open: boolean;
  editing: CredentialRecord | null;
  initialSourceKey?: string | null;
  sources: ToolSourceRecord[];
  credentials: CredentialRecord[];
  sourceAuthProfiles: Record<string, SourceAuthProfile>;
  actorIdFallback?: string;
};

type FormState = {
  sourceKey: string;
  ownerScopeType: OwnerScopeType;
  scope: CredentialScope;
  actorId: string;
  connectionMode: ConnectionMode;
  existingConnectionKey: string;
  tokenValue: string;
  apiKeyValue: string;
  basicUsername: string;
  basicPassword: string;
  customHeadersText: string;
};

type SharingScope = "only_me" | "workspace" | "organization";

function sharingScopeFromValues(values: Pick<FormState, "ownerScopeType" | "scope">): SharingScope {
  if (values.scope === "actor") {
    return "only_me";
  }
  return values.ownerScopeType === "organization" ? "organization" : "workspace";
}

function applySharingScope(scope: SharingScope): Pick<FormState, "ownerScopeType" | "scope"> {
  if (scope === "only_me") {
    return { ownerScopeType: "workspace", scope: "actor" };
  }
  if (scope === "organization") {
    return { ownerScopeType: "organization", scope: "workspace" };
  }
  return { ownerScopeType: "workspace", scope: "workspace" };
}

type FormAction =
  | { type: "patch"; patch: Partial<FormState> }
  | { type: "reset"; next: FormState };

function formReducer(state: FormState, action: FormAction): FormState {
  if (action.type === "reset") {
    return action.next;
  }
  return { ...state, ...action.patch };
}

function initialFormState({
  editing,
  initialSourceKey,
  sourceOptions,
  sourceAuthProfiles,
  actorIdFallback,
}: {
  editing: CredentialRecord | null;
  initialSourceKey?: string | null;
  sourceOptions: ReturnType<typeof buildSourceOptions>;
  sourceAuthProfiles: Record<string, SourceAuthProfile>;
  actorIdFallback?: string;
}): FormState {
  if (editing) {
    return {
      sourceKey: editing.sourceKey,
      ownerScopeType: editing.ownerScopeType ?? "workspace",
      scope: editing.scope,
      actorId: editing.actorId ?? actorIdFallback ?? "",
      connectionMode: "new",
      existingConnectionKey: `${editing.ownerScopeType ?? "workspace"}:${editing.id}`,
      tokenValue: "",
      apiKeyValue: "",
      basicUsername: "",
      basicPassword: "",
      customHeadersText: formatHeaderOverrides(editing.overridesJson),
    };
  }

  const resolvedSourceKey = initialSourceKey ?? sourceOptions[0]?.key ?? "";
  const auth = sourceAuthForKey(sourceOptions, resolvedSourceKey, sourceAuthProfiles);
  void auth;
  return {
    sourceKey: resolvedSourceKey,
    ownerScopeType: "workspace",
    scope: "actor",
    actorId: actorIdFallback ?? "",
    connectionMode: "new",
    existingConnectionKey: "",
    tokenValue: "",
    apiKeyValue: "",
    basicUsername: "",
    basicPassword: "",
    customHeadersText: "",
  };
}

export function useConnectionFormDialogForm({
  open,
  editing,
  initialSourceKey,
  sources,
  credentials,
  sourceAuthProfiles,
  actorIdFallback,
}: UseConnectionFormDialogFormParams) {
  const sourceOptions = useMemo(() => buildSourceOptions(sources), [sources]);
  const connectionOptions = useMemo(() => buildConnectionOptions(credentials), [credentials]);
  const [form, dispatch] = useReducer(
    formReducer,
    initialFormState({
      editing,
      initialSourceKey,
      sourceOptions,
      sourceAuthProfiles,
      actorIdFallback,
    }),
  );

  const {
    sourceKey,
    ownerScopeType,
    scope,
    actorId,
    connectionMode,
    existingConnectionKey: rawExistingConnectionKey,
    tokenValue,
    apiKeyValue,
    basicUsername,
    basicPassword,
    customHeadersText,
  } = form;
  const compatibleConnectionOptions = useMemo(
    () => compatibleConnections(connectionOptions, ownerScopeType, scope, actorId),
    [actorId, connectionOptions, ownerScopeType, scope],
  );
  const existingConnectionKey = useMemo(() => {
    if (!rawExistingConnectionKey) {
      return "";
    }

    return compatibleConnectionOptions.some((connection) => connection.key === rawExistingConnectionKey)
      ? rawExistingConnectionKey
      : "";
  }, [compatibleConnectionOptions, rawExistingConnectionKey]);
  const selectedAuth = useMemo(
    () => sourceAuthForKey(sourceOptions, sourceKey, sourceAuthProfiles),
    [sourceAuthProfiles, sourceKey, sourceOptions],
  );
  const authBadge = useMemo(
    () => selectedAuthBadge(selectedAuth.type, selectedAuth.mode),
    [selectedAuth.mode, selectedAuth.type],
  );
  const scopePreset = sharingScopeFromValues({ ownerScopeType, scope });

  useEffect(() => {
    if (!open) {
      return;
    }

    if (editing) {
      dispatch({
        type: "reset",
        next: initialFormState({
          editing,
          initialSourceKey,
          sourceOptions,
          sourceAuthProfiles,
          actorIdFallback,
        }),
      });
      return;
    }

    dispatch({
      type: "reset",
      next: initialFormState({
        editing: null,
        initialSourceKey,
        sourceOptions,
        sourceAuthProfiles,
        actorIdFallback,
      }),
    });
  }, [actorIdFallback, editing, initialSourceKey, open, sourceAuthProfiles, sourceOptions]);

  const handleSourceKeyChange = (nextSourceKey: string) => {
    const patch: Partial<FormState> = { sourceKey: nextSourceKey };
    dispatch({ type: "patch", patch });
  };

  const setScopePreset = (nextScopePreset: SharingScope) => {
    dispatch({
      type: "patch",
      patch: applySharingScope(nextScopePreset),
    });
  };

  const setActorId = (nextActorId: string) => {
    dispatch({ type: "patch", patch: { actorId: nextActorId } });
  };

  const setConnectionMode = (nextMode: ConnectionMode) => {
    dispatch({ type: "patch", patch: { connectionMode: nextMode } });
  };

  const setExistingConnectionKey = (nextConnectionId: string) => {
    dispatch({ type: "patch", patch: { existingConnectionKey: nextConnectionId } });
  };

  const setTokenValue = (nextToken: string) => {
    dispatch({ type: "patch", patch: { tokenValue: nextToken } });
  };

  const setApiKeyValue = (nextApiKeyValue: string) => {
    dispatch({ type: "patch", patch: { apiKeyValue: nextApiKeyValue } });
  };

  const setBasicUsername = (nextBasicUsername: string) => {
    dispatch({ type: "patch", patch: { basicUsername: nextBasicUsername } });
  };

  const setBasicPassword = (nextBasicPassword: string) => {
    dispatch({ type: "patch", patch: { basicPassword: nextBasicPassword } });
  };

  const setCustomHeadersText = (nextCustomHeadersText: string) => {
    dispatch({ type: "patch", patch: { customHeadersText: nextCustomHeadersText } });
  };

  return {
    sourceKey,
    ownerScopeType,
    scopePreset,
    scope,
    actorId,
    connectionMode,
    existingConnectionKey,
    tokenValue,
    apiKeyValue,
    basicUsername,
    basicPassword,
    customHeadersText,
    sourceOptions,
    connectionOptions,
    compatibleConnectionOptions,
    selectedAuth,
    authBadge,
    setScopePreset,
    setActorId,
    setConnectionMode,
    setExistingConnectionKey,
    setTokenValue,
    setApiKeyValue,
    setBasicUsername,
    setBasicPassword,
    setCustomHeadersText,
    handleSourceKeyChange,
  };
}

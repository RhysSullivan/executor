"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery as useConvexQuery } from "convex/react";
import { useQuery as useTanstackQuery } from "@tanstack/react-query";
import { anonymousDemoEnabled, workosEnabled } from "@/lib/auth-capabilities";
import { useWorkosAuthState } from "@/lib/convex-provider";
import { convexApi } from "@/lib/convex-api";
import {
  buildAccountWorkspaceContext,
  buildWorkspaceOptions,
  queryErrorMessage,
  resolveActiveWorkspaceId,
  type WorkosAccount,
  type WorkspaceListItem,
} from "@/lib/session/context-derivation";
import {
  clearSessionStorage,
  persistActiveWorkspaceId,
  persistSessionId,
  persistWorkspaceForAccount,
  readStoredActiveWorkspaceId,
  readStoredSessionId,
  readWorkspaceByAccount,
} from "@/lib/session-storage";
import { clearAnonymousAuth } from "@/lib/anonymous-auth";
import type { AnonymousContext } from "./types";
import type { Id } from "@executor/database/convex/_generated/dataModel";

function isGeneratedWorkosLabel(name: string | undefined): boolean {
  if (!name) {
    return false;
  }

  return /^User [A-Za-z0-9]{6}$/.test(name.trim());
}

interface SessionState {
  context: AnonymousContext | null;
  loading: boolean;
  error: string | null;
  clientConfig: {
    authProviderMode: string;
    invitesProvider: string;
    features: {
      organizations: boolean;
      billing: boolean;
      workspaceRestrictions: boolean;
    };
  } | null;
  mode: "guest" | "workos" | "anonymous";
  organizations: Array<{
    id: Id<"organizations">;
    name: string;
    slug: string;
    status: string;
    role: string;
  }>;
  organizationsLoading: boolean;
  workspaces: Array<{
    id: Id<"workspaces">;
    docId: Id<"workspaces"> | null;
    name: string;
    organizationId: Id<"organizations"> | null;
    organizationName: string;
    organizationSlug: string;
    iconUrl?: string | null;
  }>;
  switchWorkspace: (workspaceId: Id<"workspaces">) => void;
  creatingWorkspace: boolean;
  createWorkspace: (
    name: string,
    iconFile?: File | null,
    organizationId?: Id<"organizations">,
  ) => Promise<void>;
  creatingAnonymousOrganization: boolean;
  createAnonymousOrganization: () => Promise<void>;
  isSignedInToWorkos: boolean;
  workosProfile: {
    name: string;
    email?: string;
    avatarUrl?: string | null;
  } | null;
  resetWorkspace: () => Promise<void>;
}

const SessionContext = createContext<SessionState>({
  context: null,
  loading: true,
  error: null,
  clientConfig: null,
  mode: "guest",
  organizations: [],
  organizationsLoading: true,
  workspaces: [],
  switchWorkspace: () => {},
  creatingWorkspace: false,
  createWorkspace: async () => {},
  creatingAnonymousOrganization: false,
  createAnonymousOrganization: async () => {},
  isSignedInToWorkos: false,
  workosProfile: null,
  resetWorkspace: async () => {},
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const {
    loading: workosAuthLoading,
    authenticated: workosAuthenticated,
    profile: workosAuthProfile,
  } = useWorkosAuthState();
  const bootstrapAnonymousSession = useMutation(convexApi.workspace.bootstrapAnonymousSession);
  const [storedSessionId, setStoredSessionId] = useState<string | null>(readStoredSessionId);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<Id<"workspaces"> | null>(
    readStoredActiveWorkspaceId,
  );
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const clientConfig = useConvexQuery(convexApi.app.getClientConfig, {});

  const bootstrapCurrentWorkosAccount = useMutation(convexApi.auth.bootstrapCurrentWorkosAccount);
  const createWorkspaceMutation = useMutation(convexApi.workspaces.create);
  const generateWorkspaceIconUploadUrl = useMutation(convexApi.workspaces.generateWorkspaceIconUploadUrl);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [creatingAnonymousOrganization, setCreatingAnonymousOrganization] = useState(false);
  const [manualGuestContext, setManualGuestContext] = useState<AnonymousContext | null>(null);

  const bootstrapSessionQuery = useTanstackQuery({
    queryKey: ["session-bootstrap", storedSessionId ?? "new"],
    enabled: storedSessionId !== null,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      if (!storedSessionId) {
        throw new Error("No guest session id available");
      }

      const context = await bootstrapAnonymousSession({ sessionId: storedSessionId });
      persistSessionId(context.sessionId);
      if (context.sessionId !== storedSessionId) {
        setStoredSessionId(context.sessionId);
      }
      return context;
    },
  });

  const guestContext: AnonymousContext | null = manualGuestContext ?? bootstrapSessionQuery.data ?? null;

  const account = useConvexQuery(
    convexApi.app.getCurrentAccount,
    { sessionId: storedSessionId ?? undefined },
  ) as WorkosAccount | null | undefined;
  const workspaces = useConvexQuery(
    convexApi.workspaces.list,
    { sessionId: storedSessionId ?? undefined },
  ) as WorkspaceListItem[] | undefined;
  const organizations = useConvexQuery(
    convexApi.organizations.listMine,
    { sessionId: storedSessionId ?? undefined },
  );

  const resolvedActiveWorkspaceId = useMemo(() => {
    const accountId = account?._id ?? null;
    const accountStoredWorkspace = accountId ? readWorkspaceByAccount()[accountId] : null;
    return resolveActiveWorkspaceId(workspaces, activeWorkspaceId, accountStoredWorkspace);
  }, [workspaces, activeWorkspaceId, account]);

  const bootstrapWorkosAccountQuery = useTanstackQuery({
    queryKey: [
      "workos-account-bootstrap",
      storedSessionId ?? "none",
      workosAuthenticated ? "signed-in" : "signed-out",
    ],
    enabled:
      workosEnabled
      && workosAuthenticated
      && !workosAuthLoading
      && account !== undefined,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => bootstrapCurrentWorkosAccount({}),
  });

  const resetWorkspace = useCallback(async () => {
    clearSessionStorage();
    clearAnonymousAuth({ clearAccount: true });
    setStoredSessionId(null);
    setActiveWorkspaceId(null);
    setManualGuestContext(null);
    setRuntimeError(null);
  }, []);

  const createAnonymousOrganization = useCallback(async () => {
    if (!anonymousDemoEnabled) {
      throw new Error("Anonymous organization creation is disabled");
    }

    setRuntimeError(null);
    setCreatingAnonymousOrganization(true);
    try {
      const context = await bootstrapAnonymousSession({});
      persistSessionId(context.sessionId);
      persistActiveWorkspaceId(context.workspaceId);
      setStoredSessionId(context.sessionId);
      setActiveWorkspaceId(context.workspaceId);
      setManualGuestContext(context);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Failed to create anonymous organization";
      setRuntimeError(message);
      throw cause;
    } finally {
      setCreatingAnonymousOrganization(false);
    }
  }, [bootstrapAnonymousSession]);

  const switchWorkspace = useCallback((workspaceId: Id<"workspaces">) => {
    setActiveWorkspaceId(workspaceId);
    persistActiveWorkspaceId(workspaceId);

    if (account) {
      persistWorkspaceForAccount(account._id, workspaceId);
    }
  }, [account]);

  const createWorkspace = useCallback(async (
    name: string,
    iconFile?: File | null,
    organizationId?: Id<"organizations">,
  ) => {
    setCreatingWorkspace(true);
    setRuntimeError(null);
    try {
      let iconStorageId: Id<"_storage"> | undefined;

      if (iconFile) {
        const uploadUrl = await generateWorkspaceIconUploadUrl({
          sessionId: storedSessionId ?? undefined,
        });

        const uploadResult = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            "Content-Type": iconFile.type || "application/octet-stream",
          },
          body: iconFile,
        });

        if (!uploadResult.ok) {
          throw new Error("Failed to upload workspace icon");
        }

        const json = await uploadResult.json() as { storageId?: string };
        if (!json.storageId) {
          throw new Error("Upload did not return a storage id");
        }
        iconStorageId = json.storageId as Id<"_storage">;
      }

      const created = await createWorkspaceMutation({
        name,
        iconStorageId,
        organizationId,
        sessionId: storedSessionId ?? undefined,
      });

      if (created?.id) {
        switchWorkspace(created.id);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Failed to create workspace";
      setRuntimeError(message);
      throw cause;
    } finally {
      setCreatingWorkspace(false);
    }
  }, [
    createWorkspaceMutation,
    generateWorkspaceIconUploadUrl,
    storedSessionId,
    switchWorkspace,
  ]);

  const accountWorkspaceContext = useMemo<AnonymousContext | null>(() => {
    return buildAccountWorkspaceContext(
      account,
      workspaces,
      resolvedActiveWorkspaceId,
      storedSessionId,
      guestContext?.sessionId ?? null,
    );
  }, [account, guestContext?.sessionId, resolvedActiveWorkspaceId, storedSessionId, workspaces]);

  // When WorkOS is enabled, don't fall back to guest context while WorkOS
  // auth/account bootstrapping is still in flight. Otherwise workspace-bound
  // queries can run against guest workspace IDs before WorkOS memberships are
  // ready.
  const workosStillLoading = workosEnabled && (
    workosAuthLoading
    || account === undefined
    || (account?.provider === "workos" && bootstrapWorkosAccountQuery.isFetching)
  );
  const mode: "guest" | "workos" | "anonymous" = accountWorkspaceContext
    ? (account?.provider === "workos" ? "workos" : "anonymous")
    : "guest";
  const shouldBlockGuestFallback = workosEnabled && account?.provider === "workos";
  const context = accountWorkspaceContext ?? ((workosStillLoading || shouldBlockGuestFallback) ? null : guestContext);

  const bootstrapSessionError =
    storedSessionId
      ? queryErrorMessage(bootstrapSessionQuery.error, "Failed to bootstrap session")
      : null;
  const bootstrapWorkosError = queryErrorMessage(
    bootstrapWorkosAccountQuery.error,
    "Failed to bootstrap WorkOS account",
  );
  const error = runtimeError ?? bootstrapSessionError ?? bootstrapWorkosError;

  const effectiveLoading = !context && !error && (
    creatingAnonymousOrganization
    || (storedSessionId !== null && bootstrapSessionQuery.isLoading)
    || workosStillLoading
    || bootstrapWorkosAccountQuery.isFetching
  );
  const workspaceOptions = useMemo(() => {
    return buildWorkspaceOptions(mode, workspaces, guestContext);
  }, [mode, workspaces, guestContext]);
  const resolvedWorkosProfile = useMemo(() => {
    if (!account || account.provider !== "workos") {
      return null;
    }

    const accountName = account.name?.trim();
    const authName = workosAuthProfile?.name?.trim();
    const name =
      (accountName && !isGeneratedWorkosLabel(accountName) ? accountName : undefined)
      ?? authName
      ?? accountName
      ?? "User";

    return {
      name,
      email: account.email ?? workosAuthProfile?.email,
      avatarUrl: account.avatarUrl ?? workosAuthProfile?.avatarUrl ?? null,
    };
  }, [account, workosAuthProfile]);

  return (
    <SessionContext.Provider
      value={{
        context,
        loading: effectiveLoading,
        error,
        clientConfig: clientConfig ?? null,
        mode,
        organizations: organizations ?? [],
        organizationsLoading: organizations === undefined,
        workspaces: workspaceOptions,
        switchWorkspace,
        creatingWorkspace,
        createWorkspace,
        creatingAnonymousOrganization,
        createAnonymousOrganization,
        isSignedInToWorkos: Boolean(account && account.provider === "workos"),
        workosProfile: resolvedWorkosProfile,
        resetWorkspace,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  return useContext(SessionContext);
}

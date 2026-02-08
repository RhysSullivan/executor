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
import { workosEnabled } from "@/lib/auth-capabilities";
import { convexApi } from "@/lib/convex-api";
import type { AnonymousContext } from "./types";
import type { Id } from "../../../../convex/_generated/dataModel";

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
  mode: "guest" | "workos";
  organizations: Array<{
    id: Id<"organizations">;
    name: string;
    slug: string;
    status: string;
    role: string;
  }>;
  workspaces: Array<{
    id: Id<"workspaces">;
    docId: Id<"workspaces"> | null;
    name: string;
    organizationId: Id<"organizations"> | null;
    iconUrl?: string | null;
  }>;
  switchWorkspace: (workspaceId: Id<"workspaces">) => void;
  creatingWorkspace: boolean;
  createWorkspace: (name: string, iconFile?: File | null) => Promise<void>;
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
  workspaces: [],
  switchWorkspace: () => {},
  creatingWorkspace: false,
  createWorkspace: async () => {},
  isSignedInToWorkos: false,
  workosProfile: null,
  resetWorkspace: async () => {},
});

const SESSION_KEY = "executor_session_id";
const ACTIVE_WORKSPACE_KEY = "executor_active_workspace_id";
const ACTIVE_WORKSPACE_BY_ACCOUNT_KEY = "executor_active_workspace_by_account";

function readWorkspaceByAccount() {
  const raw = localStorage.getItem(ACTIVE_WORKSPACE_BY_ACCOUNT_KEY);
  if (!raw) return {} as Record<string, Id<"workspaces">>;
  try {
    const parsed = JSON.parse(raw) as Record<string, Id<"workspaces">>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function writeWorkspaceByAccount(value: Record<string, Id<"workspaces">>) {
  localStorage.setItem(ACTIVE_WORKSPACE_BY_ACCOUNT_KEY, JSON.stringify(value));
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const bootstrapAnonymousSession = useMutation(convexApi.database.bootstrapAnonymousSession);
  const [storedSessionId, setStoredSessionId] = useState<string | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    return localStorage.getItem(SESSION_KEY);
  });
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<Id<"workspaces"> | null>(() => {
    if (typeof window === "undefined") {
      return null;
    }
    const stored = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
    return stored as Id<"workspaces"> | null;
  });
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  const clientConfig = useConvexQuery(convexApi.app.getClientConfig, {});

  const authApi = convexApi.auth;
  const bootstrapCurrentWorkosAccount = useMutation(authApi.bootstrapCurrentWorkosAccount);
  const createWorkspaceMutation = useMutation(authApi.createWorkspace);
  const generateWorkspaceIconUploadUrl = useMutation(authApi.generateWorkspaceIconUploadUrl);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);

  const bootstrapSessionQuery = useTanstackQuery({
    queryKey: ["session-bootstrap", storedSessionId ?? "new"],
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const context = await bootstrapAnonymousSession({ sessionId: storedSessionId ?? undefined });
      localStorage.setItem(SESSION_KEY, context.sessionId);
      if (context.sessionId !== storedSessionId) {
        setStoredSessionId(context.sessionId);
      }
      return context;
    },
  });

  const guestContext: AnonymousContext | null = bootstrapSessionQuery.data ?? null;

  const account = useConvexQuery(
    authApi.getCurrentAccount,
    workosEnabled ? { sessionId: storedSessionId ?? undefined } : "skip",
  );
  const workspaces = useConvexQuery(
    authApi.getMyWorkspaces,
    workosEnabled ? { sessionId: storedSessionId ?? undefined } : "skip",
  );
  const organizations = useConvexQuery(
    convexApi.organizations.listMine,
    workosEnabled ? { sessionId: storedSessionId ?? undefined } : "skip",
  );

  const resolvedActiveWorkspaceId = useMemo(() => {
    if (!workspaces || workspaces.length === 0) {
      return activeWorkspaceId;
    }

    if (activeWorkspaceId && workspaces.some((workspace) => workspace._id === activeWorkspaceId)) {
      return activeWorkspaceId;
    }

    const accountId = account?.provider === "workos" ? account._id : null;
    const accountStoredWorkspace = accountId ? readWorkspaceByAccount()[accountId] : null;
    if (accountStoredWorkspace && workspaces.some((workspace) => workspace._id === accountStoredWorkspace)) {
      return accountStoredWorkspace;
    }

    return workspaces[0]?._id ?? null;
  }, [workspaces, activeWorkspaceId, account]);

  const bootstrapWorkosAccountQuery = useTanstackQuery({
    queryKey: ["workos-account-bootstrap", storedSessionId ?? "none"],
    enabled: workosEnabled && account !== undefined,
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => bootstrapCurrentWorkosAccount({}),
  });

  const resetWorkspace = useCallback(async () => {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
    setStoredSessionId(null);
    setActiveWorkspaceId(null);
    setRuntimeError(null);
  }, []);

  const switchWorkspace = useCallback((workspaceId: Id<"workspaces">) => {
    setActiveWorkspaceId(workspaceId);
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId);

    if (account?.provider === "workos") {
      const accountId = account._id;
      const byAccount = readWorkspaceByAccount();
      writeWorkspaceByAccount({
        ...byAccount,
        [accountId]: workspaceId,
      });
    }
  }, [account]);

  const createWorkspace = useCallback(async (name: string, iconFile?: File | null) => {
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
        sessionId: storedSessionId ?? undefined,
      });

      if (created?._id) {
        switchWorkspace(created._id);
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

  const workosContext = useMemo<AnonymousContext | null>(() => {
    if (!workosEnabled || !account || account.provider !== "workos" || !workspaces || workspaces.length === 0) {
      return null;
    }

    const activeWorkspace =
      workspaces.find((workspace) => workspace._id === resolvedActiveWorkspaceId)
      ?? workspaces[0]
      ?? null;
    if (!activeWorkspace) {
      return null;
    }

    return {
      sessionId: `workos_${account._id}`,
      workspaceId: activeWorkspace._id,
      actorId: activeWorkspace.userId,
      clientId: "web",
      accountId: account._id,
      userId: activeWorkspace.userId,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
  }, [account, resolvedActiveWorkspaceId, workspaces]);

  const mode: "guest" | "workos" = workosContext ? "workos" : "guest";
  const context = workosContext ?? guestContext;

  const bootstrapSessionError =
    bootstrapSessionQuery.error instanceof Error
      ? bootstrapSessionQuery.error.message
      : bootstrapSessionQuery.error
        ? "Failed to bootstrap session"
        : null;
  const bootstrapWorkosError =
    bootstrapWorkosAccountQuery.error instanceof Error
      ? bootstrapWorkosAccountQuery.error.message
      : bootstrapWorkosAccountQuery.error
        ? "Failed to bootstrap WorkOS account"
        : null;
  const error = runtimeError ?? bootstrapSessionError ?? bootstrapWorkosError;

  const waitingForWorkosAccount = Boolean(
    workosEnabled
    && account === undefined
    && !guestContext
    && !bootstrapWorkosAccountQuery.isFetching,
  );
  const effectiveLoading = !context && !error && (
    bootstrapSessionQuery.isLoading
    || waitingForWorkosAccount
    || bootstrapWorkosAccountQuery.isFetching
  );
  const workspaceOptions = useMemo(() => {
    if (mode === "workos" && workspaces) {
      return workspaces.map((workspace): SessionState["workspaces"][number] => ({
        id: workspace._id,
        docId: workspace._id,
        name: workspace.name,
        organizationId: workspace.organizationId ?? null,
        iconUrl: workspace.iconUrl,
      }));
    }

    if (guestContext) {
      return [
        {
          id: guestContext.workspaceId as Id<"workspaces">,
          docId: null,
          name: "Guest Workspace",
          organizationId: null,
        },
      ];
    }

    return [];
  }, [mode, workspaces, guestContext]);

  return (
    <SessionContext.Provider
      value={{
        context,
        loading: effectiveLoading,
        error,
        clientConfig: clientConfig ?? null,
        mode,
        organizations: organizations ?? [],
        workspaces: workspaceOptions,
        switchWorkspace,
        creatingWorkspace,
        createWorkspace,
        isSignedInToWorkos: Boolean(account && account.provider === "workos"),
        workosProfile:
          account && account.provider === "workos"
            ? {
                name: account.name,
                email: account.email,
                avatarUrl: account.avatarUrl ?? null,
              }
            : null,
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

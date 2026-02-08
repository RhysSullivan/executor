"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { workosEnabled } from "@/lib/auth-capabilities";
import { convexApi } from "@/lib/convex-api";
import type { AnonymousContext } from "./types";
import type { Id } from "../../../../convex/_generated/dataModel";

interface SessionState {
  context: AnonymousContext | null;
  loading: boolean;
  error: string | null;
  clientConfig: {
    authProviderMode: "workos" | "local";
    invitesProvider: "workos" | "local";
    features: {
      organizations: boolean;
      billing: boolean;
      workspaceRestrictions: boolean;
    };
  } | null;
  mode: "guest" | "workos";
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
    status: string;
    role: string;
  }>;
  selectedOrganizationId: string | null;
  switchOrganization: (organizationId: string | null) => void;
  workspaces: Array<{
    id: string;
    name: string;
    kind: "organization" | "personal" | "anonymous";
    organizationId: Id<"organizations"> | null;
    iconUrl?: string | null;
  }>;
  switchWorkspace: (workspaceId: string) => void;
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
  selectedOrganizationId: null,
  switchOrganization: () => {},
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
const ACTIVE_ORGANIZATION_KEY = "executor_active_organization_id";
const ACTIVE_WORKSPACE_BY_ACCOUNT_KEY = "executor_active_workspace_by_account";

function readWorkspaceByAccount() {
  const raw = localStorage.getItem(ACTIVE_WORKSPACE_BY_ACCOUNT_KEY);
  if (!raw) return {} as Record<string, string>;
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function writeWorkspaceByAccount(value: Record<string, string>) {
  localStorage.setItem(ACTIVE_WORKSPACE_BY_ACCOUNT_KEY, JSON.stringify(value));
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const bootstrapAnonymousSession = useMutation(convexApi.database.bootstrapAnonymousSession);
  const [guestContext, setGuestContext] = useState<AnonymousContext | null>(null);
  const [storedSessionId, setStoredSessionId] = useState<string | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const clientConfig = useQuery(convexApi.app.getClientConfig, {});

  const authApi = convexApi.auth;
  const bootstrapCurrentWorkosAccount = useMutation(authApi.bootstrapCurrentWorkosAccount);
  const createWorkspaceMutation = useMutation(authApi.createWorkspace);
  const generateWorkspaceIconUploadUrl = useMutation(authApi.generateWorkspaceIconUploadUrl);
  const [bootstrappingWorkos, setBootstrappingWorkos] = useState(false);
  const [workosBootstrapAttempted, setWorkosBootstrapAttempted] = useState(false);
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);

  const account = useQuery(
    authApi.getCurrentAccount,
    workosEnabled ? { sessionId: storedSessionId ?? undefined } : "skip",
  );
  const workspaces = useQuery(
    authApi.getMyWorkspaces,
    workosEnabled ? { sessionId: storedSessionId ?? undefined } : "skip",
  );
  const organizations = useQuery(
    convexApi.organizations.listMine,
    workosEnabled ? { sessionId: storedSessionId ?? undefined } : "skip",
  );

  const bootstrap = useCallback(async (sessionId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const context = await bootstrapAnonymousSession({ sessionId });
      localStorage.setItem(SESSION_KEY, context.sessionId);
      setStoredSessionId(context.sessionId);
      setGuestContext(context);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to bootstrap session");
    } finally {
      setLoading(false);
    }
  }, [bootstrapAnonymousSession]);

  useEffect(() => {
    const stored = localStorage.getItem(SESSION_KEY);
    const activeWorkspace = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
    const activeOrganization = localStorage.getItem(ACTIVE_ORGANIZATION_KEY);
    if (activeWorkspace) {
      setActiveWorkspaceId(activeWorkspace);
    }
    if (activeOrganization) {
      setSelectedOrganizationId(activeOrganization);
    }
    void bootstrap(stored ?? undefined);
  }, [bootstrap]);

  useEffect(() => {
    if (!workspaces || workspaces.length === 0) {
      return;
    }

    const accountId = account?.provider === "workos" ? String(account._id) : null;
    const byAccount = accountId ? readWorkspaceByAccount() : null;
    const accountStoredWorkspace = accountId ? byAccount?.[accountId] : null;
    const currentCandidate = activeWorkspaceId ?? accountStoredWorkspace;

    if (currentCandidate && workspaces.some((workspace) => workspace.runtimeWorkspaceId === currentCandidate)) {
      if (activeWorkspaceId !== currentCandidate) {
        setActiveWorkspaceId(currentCandidate);
      }
      return;
    }

    const organizationWorkspace = workspaces.find(
      (workspace) => workspace.kind === "organization" || workspace.kind === "org",
    );
    const nextWorkspace = organizationWorkspace?.runtimeWorkspaceId ?? workspaces[0]?.runtimeWorkspaceId;
    if (!nextWorkspace) {
      return;
    }

    setActiveWorkspaceId(nextWorkspace);
    if (accountId) {
      writeWorkspaceByAccount({
        ...(byAccount ?? {}),
        [accountId]: nextWorkspace,
      });
    }
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, nextWorkspace);
  }, [workspaces, activeWorkspaceId, account]);

  useEffect(() => {
    if (!organizations || organizations.length === 0) {
      if (selectedOrganizationId !== null) {
        setSelectedOrganizationId(null);
        localStorage.removeItem(ACTIVE_ORGANIZATION_KEY);
      }
      return;
    }

    if (selectedOrganizationId && organizations.some((organization) => organization.id === selectedOrganizationId)) {
      return;
    }

    const nextOrganizationId = organizations[0]?.id ?? null;
    setSelectedOrganizationId(nextOrganizationId);
    if (nextOrganizationId) {
      localStorage.setItem(ACTIVE_ORGANIZATION_KEY, nextOrganizationId);
    }
  }, [organizations, selectedOrganizationId]);

  useEffect(() => {
    if (!workspaces || workspaces.length === 0 || !activeWorkspaceId) {
      return;
    }

    const activeWorkspace = workspaces.find((workspace) => workspace.runtimeWorkspaceId === activeWorkspaceId);
    if (!activeWorkspace) {
      return;
    }

    const workspaceOrganizationId = activeWorkspace.organizationId ? String(activeWorkspace.organizationId) : null;
    if (workspaceOrganizationId === selectedOrganizationId) {
      return;
    }

    setSelectedOrganizationId(workspaceOrganizationId);
    if (workspaceOrganizationId) {
      localStorage.setItem(ACTIVE_ORGANIZATION_KEY, workspaceOrganizationId);
    } else {
      localStorage.removeItem(ACTIVE_ORGANIZATION_KEY);
    }
  }, [workspaces, activeWorkspaceId, selectedOrganizationId]);

  useEffect(() => {
    if (
      !workosEnabled
      || account !== null
      || bootstrappingWorkos
      || workosBootstrapAttempted
    ) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        setWorkosBootstrapAttempted(true);
        setBootstrappingWorkos(true);
        await bootstrapCurrentWorkosAccount({});
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Failed to bootstrap WorkOS account");
        }
      } finally {
        if (!cancelled) {
          setBootstrappingWorkos(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [account, bootstrapCurrentWorkosAccount, bootstrappingWorkos, workosBootstrapAttempted]);

  useEffect(() => {
    if (account === undefined) {
      setWorkosBootstrapAttempted(false);
    }
  }, [account]);

  const resetWorkspace = useCallback(async () => {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
    localStorage.removeItem(ACTIVE_ORGANIZATION_KEY);
    setStoredSessionId(null);
    setActiveWorkspaceId(null);
    setSelectedOrganizationId(null);
    await bootstrap();
  }, [bootstrap]);

  const switchWorkspace = useCallback((workspaceId: string) => {
    setActiveWorkspaceId(workspaceId);
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId);

    const selectedWorkspace = workspaces?.find((workspace) => workspace.runtimeWorkspaceId === workspaceId) ?? null;
    const nextOrganizationId = selectedWorkspace?.organizationId ? String(selectedWorkspace.organizationId) : null;
    setSelectedOrganizationId(nextOrganizationId);
    if (nextOrganizationId) {
      localStorage.setItem(ACTIVE_ORGANIZATION_KEY, nextOrganizationId);
    } else {
      localStorage.removeItem(ACTIVE_ORGANIZATION_KEY);
    }

    if (account?.provider === "workos") {
      const accountId = String(account._id);
      const byAccount = readWorkspaceByAccount();
      writeWorkspaceByAccount({
        ...byAccount,
        [accountId]: workspaceId,
      });
    }
  }, [account, workspaces]);

  const switchOrganization = useCallback((organizationId: string | null) => {
    setSelectedOrganizationId(organizationId);
    if (organizationId) {
      localStorage.setItem(ACTIVE_ORGANIZATION_KEY, organizationId);
    } else {
      localStorage.removeItem(ACTIVE_ORGANIZATION_KEY);
    }

    if (!workspaces || workspaces.length === 0) {
      return;
    }

    const firstWorkspaceForOrg = workspaces.find((workspace) => {
      const workspaceOrgId = workspace.organizationId ? String(workspace.organizationId) : null;
      if (organizationId === null) {
        return workspaceOrgId === null;
      }
      return workspaceOrgId === organizationId;
    });

    if (firstWorkspaceForOrg?.runtimeWorkspaceId) {
      switchWorkspace(firstWorkspaceForOrg.runtimeWorkspaceId);
    }
  }, [switchWorkspace, workspaces]);

  const createWorkspace = useCallback(async (name: string, iconFile?: File | null) => {
    setCreatingWorkspace(true);
    setError(null);
    try {
      let iconStorageId: string | undefined;

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
        iconStorageId = json.storageId;
      }

      const created = await createWorkspaceMutation({
        name,
        iconStorageId,
        sessionId: storedSessionId ?? undefined,
      });

      if (created?.runtimeWorkspaceId) {
        switchWorkspace(created.runtimeWorkspaceId);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Failed to create workspace";
      setError(message);
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
      workspaces.find((workspace) => workspace.runtimeWorkspaceId === activeWorkspaceId)
      ?? workspaces[0]
      ?? null;
    if (!activeWorkspace) {
      return null;
    }

    return {
      sessionId: `workos_${String(account._id)}`,
      workspaceId: activeWorkspace.runtimeWorkspaceId,
      actorId: String(activeWorkspace.userId),
      clientId: "web",
      accountId: String(account._id),
      workspaceDocId: String(activeWorkspace._id),
      userId: String(activeWorkspace.userId),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
  }, [account, activeWorkspaceId, workspaces]);

  const mode: "guest" | "workos" = workosContext ? "workos" : "guest";
  const context = workosContext ?? guestContext;
  const waitingForWorkosAccount = Boolean(
    workosEnabled
    && account === undefined
    && !guestContext
    && !bootstrappingWorkos,
  );
  const effectiveLoading = !context && !error && (
    loading
    || waitingForWorkosAccount
    || bootstrappingWorkos
  );
  const workspaceOptions = useMemo(() => {
    if (mode === "workos" && workspaces) {
      return workspaces.map((workspace) => ({
        id: workspace.runtimeWorkspaceId,
        name: workspace.name,
        kind:
          workspace.kind === "organization" || workspace.kind === "org"
            ? "organization"
            : workspace.kind === "personal"
              ? "personal"
              : "anonymous",
        organizationId: workspace.organizationId ?? null,
        iconUrl: workspace.iconUrl,
      }));
    }

    if (guestContext) {
      return [
        {
          id: guestContext.workspaceId,
          name: "Guest Workspace",
          kind: "anonymous" as const,
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
        selectedOrganizationId,
        switchOrganization,
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

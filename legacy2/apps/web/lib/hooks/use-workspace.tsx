"use client";

import { createContext, useContext, useMemo, useCallback, useState, type ReactNode } from "react";
import type { WorkspaceId } from "@executor-v2/schema";

type WorkspaceContextValue = {
  workspaceId: WorkspaceId;
  workspaceIdInput: string;
  setWorkspaceId: (value: string) => void;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace must be used within a WorkspaceProvider");
  }
  return ctx;
}

type WorkspaceProviderProps = {
  initialWorkspaceId: string;
  children: ReactNode;
};

export function WorkspaceProvider({ initialWorkspaceId, children }: WorkspaceProviderProps) {
  const [workspaceIdInput, setWorkspaceIdInput] = useState(initialWorkspaceId);
  const workspaceId = workspaceIdInput as WorkspaceId;
  const setWorkspaceId = useCallback((value: string) => {
    setWorkspaceIdInput(value);
  }, []);

  const value = useMemo<WorkspaceContextValue>(
    () => ({ workspaceId, workspaceIdInput, setWorkspaceId }),
    [workspaceId, workspaceIdInput, setWorkspaceId],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

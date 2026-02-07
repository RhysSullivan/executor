"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { bootstrapAnonymousContext } from "./api";
import type { AnonymousContext } from "./types";

interface SessionState {
  context: AnonymousContext | null;
  loading: boolean;
  error: string | null;
  resetWorkspace: () => Promise<void>;
}

const SessionContext = createContext<SessionState>({
  context: null,
  loading: true,
  error: null,
  resetWorkspace: async () => {},
});

const SESSION_KEY = "executor_session_id";

export function SessionProvider({ children }: { children: ReactNode }) {
  const [context, setContext] = useState<AnonymousContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const bootstrap = useCallback(async (sessionId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const ctx = await bootstrapAnonymousContext(sessionId);
      localStorage.setItem(SESSION_KEY, ctx.sessionId);
      setContext(ctx);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to bootstrap session");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem(SESSION_KEY);
    bootstrap(stored ?? undefined);
  }, [bootstrap]);

  const resetWorkspace = useCallback(async () => {
    localStorage.removeItem(SESSION_KEY);
    await bootstrap();
  }, [bootstrap]);

  return (
    <SessionContext.Provider value={{ context, loading, error, resetWorkspace }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  return useContext(SessionContext);
}

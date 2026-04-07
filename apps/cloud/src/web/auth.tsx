import React, { createContext, useContext, useEffect, useState } from "react";

type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

type AuthTeam = {
  id: string;
  name: string;
};

type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: AuthUser; team: AuthTeam };

const AuthContext = createContext<AuthState>({ status: "loading" });

export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    fetch("/auth/me")
      .then((res) => {
        if (!res.ok) {
          setState({ status: "unauthenticated" });
          return;
        }
        return res.json();
      })
      .then((data) => {
        if (data?.user) {
          setState({
            status: "authenticated",
            user: data.user,
            team: data.team,
          });
        }
      })
      .catch(() => {
        setState({ status: "unauthenticated" });
      });
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
};

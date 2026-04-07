import React from "react";
import { RouterProvider } from "@tanstack/react-router";
import { AuthProvider, useAuth } from "./auth";
import { LoginPage } from "./pages/login";
import { router } from "./router";

const AuthGate = () => {
  const auth = useAuth();

  if (auth.status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (auth.status === "unauthenticated") {
    return <LoginPage />;
  }

  return <RouterProvider router={router} />;
};

export const App = () => (
  <AuthProvider>
    <AuthGate />
  </AuthProvider>
);

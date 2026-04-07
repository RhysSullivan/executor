import React from "react";

export const LoginPage = () => {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-6">
        <div className="flex flex-col items-center gap-2">
          <h1 className="font-serif text-4xl">Executor</h1>
          <p className="text-sm text-muted-foreground">
            Sign in to manage your tools and sources
          </p>
        </div>
        <a
          href="/auth/login"
          className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 transition-colors"
        >
          Sign in
        </a>
      </div>
    </div>
  );
};

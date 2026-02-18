import { HeadContent, Navigate, Scripts, createRootRoute } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { AppConvexProvider } from "@/lib/convex-provider";
import { QueryProvider } from "@/lib/query-provider";
import { SessionProvider } from "@/lib/session-context";
import { AppErrorBoundary } from "@/components/app-error-boundary";
import { runtimeConfigFromEnv } from "@/lib/runtime-config";
import appCss from "../app/globals.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Executor Console",
      },
      {
        name: "description",
        content: "Approval-first runtime console for AI-generated code execution",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFoundRedirect,
});

function NotFoundRedirect() {
  return <Navigate to="/" replace />;
}

function RootDocument({ children }: { children: React.ReactNode }) {
  const runtimeConfig = JSON.stringify(runtimeConfigFromEnv());

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="antialiased">
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__EXECUTOR_RUNTIME_CONFIG__ = ${runtimeConfig};`,
          }}
        />
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          enableColorScheme
        >
          <AppErrorBoundary>
            <QueryProvider>
              <AppConvexProvider>
                <SessionProvider>
                  {children}
                </SessionProvider>
              </AppConvexProvider>
            </QueryProvider>
          </AppErrorBoundary>
          <Toaster position="bottom-right" />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}

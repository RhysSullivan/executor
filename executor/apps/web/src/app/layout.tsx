import type { Metadata } from "next";
import { JetBrains_Mono, Inter } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { AppConvexProvider } from "@/lib/convex-provider";
import { QueryProvider } from "@/lib/query-provider";
import { SessionProvider } from "@/lib/session-context";
import { AppErrorBoundary } from "@/components/app-error-boundary";
import "./globals.css";

function runtimeConvexUrl(): string | null {
  const candidate =
    process.env.EXECUTOR_WEB_CONVEX_URL
    ?? process.env.CONVEX_URL
    ?? process.env.NEXT_PUBLIC_CONVEX_URL
    ?? null;

  const trimmed = candidate?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

const inter = Inter({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Executor Console",
  description: "Approval-first runtime console for AI-generated code execution",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const convexUrl = runtimeConvexUrl();
  const runtimeConfig = JSON.stringify({ convexUrl });

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} antialiased`}
      >
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
      </body>
    </html>
  );
}

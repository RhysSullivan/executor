import type { Metadata } from "next";
import { JetBrains_Mono, Inter } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { AppConvexProvider } from "@/lib/convex-provider";
import { QueryProvider } from "@/lib/query-provider";
import { SessionProvider } from "@/lib/session-context";
import "./globals.css";

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
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          enableColorScheme
        >
          <QueryProvider>
            <AppConvexProvider>
              <SessionProvider>
                {children}
              </SessionProvider>
            </AppConvexProvider>
          </QueryProvider>
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}

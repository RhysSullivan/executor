import type { Metadata } from "next";
import { JetBrains_Mono, Inter } from "next/font/google";
import { Toaster } from "sonner";
import { AppConvexProvider } from "@/lib/convex-provider";
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
    <html lang="en" className="dark">
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} antialiased`}
      >
        <AppConvexProvider>
          <SessionProvider>
            {children}
          </SessionProvider>
        </AppConvexProvider>
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            style: {
              background: "oklch(0.15 0.005 260)",
              border: "1px solid oklch(0.24 0.008 260)",
              color: "oklch(0.88 0.01 250)",
            },
          }}
        />
      </body>
    </html>
  );
}

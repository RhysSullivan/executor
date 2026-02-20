import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <Suspense>{children}</Suspense>
    </AppShell>
  );
}

import { withAuth } from "@workos-inc/authkit-nextjs";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { isWorkosEnabled } from "../../lib/workos";
import { ConsoleShell } from "./console-shell";

type ConsoleLayoutProps = {
  children: ReactNode;
};

const ConsoleLayout = async ({ children }: ConsoleLayoutProps) => {
  const authEnabled = isWorkosEnabled();

  if (authEnabled) {
    const { user } = await withAuth();

    if (!user) {
      redirect("/sign-in");
    }

    return (
      <ConsoleShell
        authEnabled
        initialWorkspaceId={`ws_${user.id}`}
      >
        {children}
      </ConsoleShell>
    );
  }

  return (
    <ConsoleShell
      authEnabled={false}
      initialWorkspaceId="ws_demo"
    >
      {children}
    </ConsoleShell>
  );
};

export default ConsoleLayout;

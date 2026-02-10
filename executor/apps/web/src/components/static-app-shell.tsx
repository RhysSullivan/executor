"use client";

import dynamic from "next/dynamic";

const FrontendApp = dynamic(() => import("@/frontend/app"), {
  ssr: false,
});

export function StaticAppShell() {
  return <FrontendApp />;
}

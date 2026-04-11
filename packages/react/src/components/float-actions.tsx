import * as React from "react";
import { useRouterState } from "@tanstack/react-router";

import { cn } from "../lib/utils";
import { CardStack } from "./card-stack";

/**
 * A floating action bar that pins itself to the bottom of the nearest
 * positioned ancestor (usually a scroll container with `position: relative`).
 *
 * Rendered as a `CardStack` so it picks up the card visual — wrap action
 * buttons as children; they'll be right-aligned inside the card.
 *
 * To pin to the bottom even when content is short, the parent should be a
 * flex column filling the scroll container (so `mt-auto` pushes the actions
 * down). `sticky bottom-4` also keeps it visible while scrolling long content.
 *
 * Hidden while the router is navigating/loading so the actions don't flash
 * on top of a loading state.
 */
function FloatActions({ className, children }: { className?: string; children: React.ReactNode }) {
  const isLoading = useRouterState({ select: (s) => s.isLoading });

  if (isLoading) {
    return null;
  }

  return (
    <CardStack className={cn("sticky shadow-lg bottom-4 left-0 right-0 mt-auto w-full", className)}>
      <div className="flex items-center justify-end gap-3 px-4 py-3">{children}</div>
    </CardStack>
  );
}

export { FloatActions };

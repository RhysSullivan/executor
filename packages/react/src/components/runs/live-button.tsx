import { CirclePause, CirclePlay } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../button";

// ---------------------------------------------------------------------------
// LiveButton — openstatus-style outline button with play/pause icon
// ---------------------------------------------------------------------------
//
// Ported from `~/Developer/openstatus-data-table/src/components/data-table/
// data-table-infinite/live-button.tsx`. When active, the border and text
// become info-colored; the icon switches from Play to Pause.

export interface LiveButtonProps {
  readonly active: boolean;
  readonly onClick: () => void;
}

export function LiveButton({ active, onClick }: LiveButtonProps) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className={cn(
        "shadow-none",
        active &&
          "border-[color:var(--color-info)] text-[color:var(--color-info)] hover:text-[color:var(--color-info)]",
      )}
      title={active ? "Pause live refresh (j)" : "Start live refresh (j)"}
    >
      {active ? (
        <CirclePause className="size-4" />
      ) : (
        <CirclePlay className="size-4" />
      )}
      Live
    </Button>
  );
}

import { CirclePause, CirclePlay } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../button";

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
      {active ? <CirclePause className="size-4" /> : <CirclePlay className="size-4" />}
      Live
    </Button>
  );
}

import { LoaderCircle, RefreshCcw } from "lucide-react";

import { Button } from "../button";

export interface RefreshButtonProps {
  readonly onClick: () => void;
  readonly isLoading?: boolean;
}

export function RefreshButton({ onClick, isLoading }: RefreshButtonProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      onClick={onClick}
      disabled={isLoading}
      className="shadow-none"
      title="Refresh (r)"
      aria-label="Refresh"
    >
      {isLoading ? (
        <LoaderCircle className="size-4 animate-spin" />
      ) : (
        <RefreshCcw className="size-4" />
      )}
    </Button>
  );
}

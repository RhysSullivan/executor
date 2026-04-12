import * as React from "react";
import { Keyboard } from "lucide-react";

import { Button } from "../button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../dropdown-menu";

const SHORTCUTS: ReadonlyArray<{
  readonly label: string;
  readonly key: string;
}> = [
  { label: "Toggle live refresh", key: "J" },
  { label: "Refresh data", key: "R" },
  { label: "Open filter command", key: "/" },
  { label: "Toggle filter rail", key: "B" },
  { label: "Previous run in drawer", key: "↑" },
  { label: "Next run in drawer", key: "↓" },
  { label: "Close drawer / dialog", key: "Esc" },
  { label: "Show this menu", key: "?" },
];

export interface KeyboardHelpButtonProps {
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

export function KeyboardHelpButton({ open, onOpenChange }: KeyboardHelpButtonProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shadow-none"
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
        >
          <Keyboard className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Keyboard shortcuts
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {SHORTCUTS.map((shortcut) => (
          <DropdownMenuItem key={shortcut.label} className="text-xs">
            <span>{shortcut.label}</span>
            <DropdownMenuShortcut className="font-mono">{shortcut.key}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

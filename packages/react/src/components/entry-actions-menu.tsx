import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

export function KebabRemoveMenu(props: { label: string; onRemove: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 opacity-0 transition-opacity group-hover/card-stack-entry:opacity-100 group-focus-within/card-stack-entry:opacity-100 data-[state=open]:opacity-100"
        >
          <svg viewBox="0 0 16 16" className="size-3">
            <circle cx="8" cy="3" r="1.2" fill="currentColor" />
            <circle cx="8" cy="8" r="1.2" fill="currentColor" />
            <circle cx="8" cy="13" r="1.2" fill="currentColor" />
          </svg>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem
          className="text-destructive focus:text-destructive text-sm"
          onClick={props.onRemove}
        >
          {props.label}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

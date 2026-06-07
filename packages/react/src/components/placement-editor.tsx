import { PlusIcon, XIcon } from "lucide-react";

import {
  emptyPlacement,
  PlacementLine,
  type Carrier,
  type Placement,
} from "../lib/auth-placements";
import { Button } from "./button";
import { Input } from "./input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

// ---------------------------------------------------------------------------
// Placement editor — vertical "where does the credential go" cards.
//
// Each card: [Header/Query select] [name] [✕] / Prefix [input] / live preview.
// "+ another location" appends an empty header placement. Ported from the
// approved prototype, rebuilt on the production design system.
// ---------------------------------------------------------------------------

export function PlacementEditor(props: {
  readonly placements: readonly Placement[];
  readonly onChange: (placements: Placement[]) => void;
}) {
  const { placements, onChange } = props;

  const set = (index: number, patch: Partial<Placement>): void =>
    onChange(placements.map((p: Placement, j: number) => (j === index ? { ...p, ...patch } : p)));

  const remove = (index: number): void =>
    onChange(placements.filter((_p: Placement, j: number) => j !== index));

  return (
    <div className="flex flex-col gap-2.5">
      {placements.map((placement: Placement, index: number) => (
        <div key={index} className="rounded-lg border border-border/60 bg-muted/30 p-3">
          <div className="flex items-center gap-2">
            <Select
              value={placement.carrier}
              onValueChange={(value: string) => set(index, { carrier: value as Carrier })}
            >
              <SelectTrigger size="sm" className="w-32 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="header">Header</SelectItem>
                <SelectItem value="query">Query param</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="h-8 flex-1"
              placeholder={placement.carrier === "header" ? "Authorization" : "api_key"}
              value={placement.name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                set(index, { name: e.target.value })
              }
            />
            {placements.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Remove location"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => remove(index)}
              >
                <XIcon />
              </Button>
            )}
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <span className="w-32 shrink-0 pl-0.5 text-xs text-muted-foreground">Prefix</span>
            <Input
              className="h-8 flex-1"
              placeholder="optional — e.g. Bearer "
              value={placement.prefix}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                set(index, { prefix: e.target.value })
              }
            />
          </div>
          {placement.name ? (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-dashed border-border/60 pt-2.5 text-xs text-muted-foreground">
              <span>sends</span>
              <PlacementLine placement={placement} />
            </div>
          ) : null}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => onChange([...placements, emptyPlacement()])}
      >
        <PlusIcon />
        another location
      </Button>
    </div>
  );
}

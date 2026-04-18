import { useMemo, useState, type ChangeEvent, type FocusEvent } from "react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { Input } from "../components/input";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../components/command";
import { Popover, PopoverAnchor, PopoverContent } from "../components/popover";
import { AddSecretDialog } from "./add-secret-dialog";

export interface SecretPickerSecret {
  readonly id: string;
  readonly name: string;
  readonly provider?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  keychain: "Keychain",
  file: "Local",
  memory: "Memory",
  onepassword: "1Password",
};

const providerLabel = (key: string | undefined): string => {
  if (!key) return "Local";
  return PROVIDER_LABELS[key] ?? key;
};

export function SecretPicker(props: {
  readonly value: string | null;
  readonly onSelect: (secretId: string) => void;
  readonly secrets: readonly SecretPickerSecret[];
  readonly placeholder?: string;
  /** Show a chevron indicator to make the input look like a select dropdown. */
  readonly showChevron?: boolean;
  /** Mark the field as invalid (renders destructive ring). */
  readonly invalid?: boolean;
}) {
  const { value, onSelect, secrets, placeholder = "Search secrets…", showChevron = false, invalid = false } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const selected = secrets.find((secret) => secret.id === value) ?? null;

  // Group + sort only when the secrets list changes (not on every keystroke).
  const groups = useMemo<readonly (readonly [string, readonly SecretPickerSecret[]])[]>(() => {
    const grouped = new Map<string, SecretPickerSecret[]>();
    for (const secret of secrets) {
      const key = providerLabel(secret.provider);
      const group = grouped.get(key);
      if (group) {
        group.push(secret);
      } else {
        grouped.set(key, [secret]);
      }
    }
    return [...grouped.entries()]
      .map(
        ([label, items]) =>
          [label, [...items].sort((a, b) => a.name.localeCompare(b.name))] as const,
      )
      .sort(([a], [b]) => a.localeCompare(b));
  }, [secrets]);

  const showGroupHeadings = groups.length > 1;

  // Apply query filter once per keystroke, not per-group in render.
  const filteredGroups = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();
    if (!lowerQuery) return groups;
    const result: (readonly [string, readonly SecretPickerSecret[]])[] = [];
    for (const [label, items] of groups) {
      const filtered = items.filter(
        (secret) =>
          secret.name.toLowerCase().includes(lowerQuery) ||
          secret.id.toLowerCase().includes(lowerQuery),
      );
      if (filtered.length > 0) result.push([label, filtered] as const);
    }
    return result;
  }, [groups, query]);

  return (
    <div className="relative w-full">
      <Popover open={open} onOpenChange={setOpen} modal={false}>
        <PopoverAnchor asChild>
          <div className="relative">
            <Input
              value={open ? query : selected ? selected.name : ""}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                setQuery(event.target.value);
                if (!open) setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onBlur={(event: FocusEvent<HTMLInputElement>) => {
                const related = event.relatedTarget as HTMLElement | null;
                if (related?.closest("[data-slot=popover-content]")) return;
                setOpen(false);
              }}
              placeholder={placeholder}
              aria-invalid={invalid || undefined}
              className={cn("text-sm", showChevron && "pr-8")}
            />
            {showChevron && (
              <ChevronDownIcon
                className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground/50"
                aria-hidden
              />
            )}
          </div>
        </PopoverAnchor>
        <PopoverContent
          className="w-(--radix-popover-trigger-width) p-0"
          align="start"
          onOpenAutoFocus={(event: Event) => event.preventDefault()}
          onCloseAutoFocus={(event: Event) => event.preventDefault()}
          onInteractOutside={(event: Event) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest("[data-slot=popover-anchor]")) {
              event.preventDefault();
            }
          }}
        >
          <Command shouldFilter={false}>
            <CommandList>
              <CommandGroup>
                <CommandItem
                  onSelect={() => {
                    setOpen(false);
                    setQuery("");
                    setAddDialogOpen(true);
                  }}
                  className="gap-2 text-primary"
                >
                  <PlusIcon className="size-3.5" />
                  <span>Add secret…</span>
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandEmpty>No secrets found</CommandEmpty>
              {filteredGroups.map(([label, items]) => (
                <CommandGroup key={label} heading={showGroupHeadings ? label : undefined}>
                  {items.map((secret) => (
                    <CommandItem
                      key={secret.id}
                      value={`${secret.name} ${secret.id}`}
                      onSelect={() => {
                        onSelect(secret.id);
                        setOpen(false);
                        setQuery("");
                      }}
                    >
                      <span className="truncate">{secret.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <AddSecretDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onCreated={(secretId) => {
          onSelect(secretId);
          setAddDialogOpen(false);
        }}
      />
    </div>
  );
}

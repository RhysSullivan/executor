import { useState, type ChangeEvent, type FocusEvent } from "react";

import { Input } from "../components/input";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "../components/command";
import { Popover, PopoverAnchor, PopoverContent } from "../components/popover";

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
}) {
  const { value, onSelect, secrets, placeholder = "Search secrets…" } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = secrets.find((secret) => secret.id === value) ?? null;

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

  const groups: [string, SecretPickerSecret[]][] = [...grouped.entries()]
    .map(([label, items]): [string, SecretPickerSecret[]] => [
      label,
      [...items].sort((a, b) => a.name.localeCompare(b.name)),
    ])
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="relative w-full">
      <Popover open={open} onOpenChange={setOpen} modal={false}>
        <PopoverAnchor asChild>
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
            className="text-sm"
          />
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
              <CommandEmpty>No secrets found</CommandEmpty>
              {groups.map(([label, items]) => {
                const lowerQuery = query.toLowerCase();
                const filtered = lowerQuery
                  ? items.filter(
                      (secret) =>
                        secret.name.toLowerCase().includes(lowerQuery) ||
                        secret.id.toLowerCase().includes(lowerQuery),
                    )
                  : items;
                if (filtered.length === 0) return null;
                return (
                  <CommandGroup key={label} heading={label}>
                    {filtered.map((secret) => (
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
                        <span className="ml-auto truncate text-[10px] font-mono text-muted-foreground">
                          {secret.id}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

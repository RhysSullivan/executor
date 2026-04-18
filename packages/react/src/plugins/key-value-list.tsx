import { useId, type ReactNode } from "react";
import { TrashIcon } from "lucide-react";

import { Button } from "../components/button";
import { CardStackEmpty } from "../components/card-stack";
import { Input } from "../components/input";
import { NativeSelect, NativeSelectOption } from "../components/native-select";
import { SecretPicker, type SecretPickerSecret } from "./secret-picker";

export type KeyValueType = "text" | "secret";

export interface KeyValueEntry {
  /**
   * Stable identity for this row. Used as the React `key` so that focus and
   * uncontrolled state do not leak across re-orders/removes. Callers should
   * generate it once when adding a new row (e.g. `newKeyValueEntry()` below).
   */
  id: string;
  key: string;
  value: string;
  type: KeyValueType;
}

/**
 * Create a new empty `KeyValueEntry` with a fresh stable `id`. Prefer this
 * helper over hand-constructing entries so the row identity is never missed.
 */
export function newKeyValueEntry(overrides?: Partial<Omit<KeyValueEntry, "id">>): KeyValueEntry {
  return {
    id: generateEntryId(),
    key: overrides?.key ?? "",
    value: overrides?.value ?? "",
    type: overrides?.type ?? "text",
  };
}

function generateEntryId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID (older test harnesses).
  return `kv-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export interface KeyValueListProps {
  readonly entries: readonly KeyValueEntry[];
  readonly onChange: (entries: readonly KeyValueEntry[]) => void;
  readonly secrets?: readonly SecretPickerSecret[];
  readonly emptyLabel?: ReactNode;
  readonly keyPlaceholder?: string;
  readonly valuePlaceholder?: string;
}

/**
 * Renders key-value rows without a wrapper. Expects to be placed inside
 * a `CardStackContent`. The parent is responsible for the CardStack shell
 * and header (with the add button).
 */
export function KeyValueList({
  entries,
  onChange,
  secrets = [],
  emptyLabel = "No entries",
  keyPlaceholder = "Key",
  valuePlaceholder = "Value",
}: KeyValueListProps) {
  const updateEntry = (id: string, update: Partial<Omit<KeyValueEntry, "id">>) => {
    onChange(
      entries.map((entry) => (entry.id === id ? { ...entry, ...update } : entry)),
    );
  };

  const removeEntry = (id: string) => {
    onChange(entries.filter((entry) => entry.id !== id));
  };

  if (entries.length === 0) {
    return <CardStackEmpty>{emptyLabel}</CardStackEmpty>;
  }

  return (
    <>
      {entries.map((entry) => (
        <KeyValueRow
          key={entry.id}
          entry={entry}
          onChange={(update) => updateEntry(entry.id, update)}
          onRemove={() => removeEntry(entry.id)}
          secrets={secrets}
          keyPlaceholder={keyPlaceholder}
          valuePlaceholder={valuePlaceholder}
        />
      ))}
    </>
  );
}

function KeyValueRow(props: {
  entry: KeyValueEntry;
  onChange: (update: Partial<Omit<KeyValueEntry, "id">>) => void;
  onRemove: () => void;
  secrets: readonly SecretPickerSecret[];
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  const keyId = useId();
  const valueId = useId();
  const { entry, onChange, onRemove, secrets, keyPlaceholder, valuePlaceholder } = props;

  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <Input
          id={keyId}
          value={entry.key}
          onChange={(e) => onChange({ key: (e.target as HTMLInputElement).value })}
          placeholder={keyPlaceholder}
          aria-label="Key"
          className="font-mono text-sm"
        />
      </div>
      <div className="min-w-0 flex-1">
        {entry.type === "secret" ? (
          <SecretPicker
            value={entry.value || null}
            onSelect={(secretId) => onChange({ value: secretId })}
            secrets={secrets}
            showChevron
          />
        ) : (
          <Input
            id={valueId}
            value={entry.value}
            onChange={(e) => onChange({ value: (e.target as HTMLInputElement).value })}
            placeholder={valuePlaceholder}
            aria-label="Value"
            className="font-mono text-sm"
          />
        )}
      </div>
      <div className="shrink-0">
        <NativeSelect
          value={entry.type}
          onChange={(e) =>
            onChange({
              type: (e.target as HTMLSelectElement).value as KeyValueType,
              value: "",
            })
          }
          size="sm"
          className="text-sm"
        >
          <NativeSelectOption value="text">Text</NativeSelectOption>
          <NativeSelectOption value="secret">Secret</NativeSelectOption>
        </NativeSelect>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        type="button"
        className="mb-1 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
        aria-label="Remove"
      >
        <TrashIcon className="size-4 shrink-0" />
      </Button>
    </div>
  );
}

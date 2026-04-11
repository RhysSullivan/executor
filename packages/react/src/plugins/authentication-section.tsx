import { useState, type ReactNode } from "react";
import { PlusIcon } from "lucide-react";

import { Button } from "../components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEmpty,
  CardStackEntry,
} from "../components/card-stack";
import { FieldLabel } from "../components/field";
import { FilterTabs } from "../components/filter-tabs";
import {
  defaultHeaderAuthPresets,
  type HeaderAuthPreset,
  SecretHeaderAuthRow,
  type HeaderState,
} from "./secret-header-auth";
import type { SecretPickerSecret } from "./secret-picker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthMethod = "none" | "header" | "oauth2";

export type AuthHeaderEntry = HeaderState;

const DEFAULT_METHOD_LABELS: Record<AuthMethod, string> = {
  none: "None",
  header: "Header",
  oauth2: "OAuth",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface AuthenticationSectionProps {
  /** Auth methods to expose as tabs (display order). */
  readonly methods: readonly AuthMethod[];
  readonly value: AuthMethod;
  readonly onChange: (value: AuthMethod) => void;

  /** Headers list — used when value === "header". */
  readonly headers?: readonly AuthHeaderEntry[];
  readonly onHeadersChange?: (headers: AuthHeaderEntry[]) => void;
  readonly existingSecrets?: readonly SecretPickerSecret[];

  /** Optional content rendered for the "oauth2" method. */
  readonly oauth2Slot?: ReactNode;

  /**
   * When true, the headers list is constrained to a single entry: the
   * "Add headers" button is hidden once one header exists and rows cannot
   * be removed. Useful for consumers whose backend only supports a single
   * auth header.
   */
  readonly singleHeader?: boolean;

  readonly methodLabels?: Partial<Record<AuthMethod, string>>;
  readonly label?: ReactNode;
}

export function AuthenticationSection(props: AuthenticationSectionProps) {
  const {
    methods,
    value,
    onChange,
    headers = [],
    onHeadersChange,
    existingSecrets = [],
    oauth2Slot,
    singleHeader = false,
    methodLabels,
    label = "Authentication",
  } = props;

  const [picking, setPicking] = useState(false);

  const getMethodLabel = (method: AuthMethod) =>
    methodLabels?.[method] ?? DEFAULT_METHOD_LABELS[method];

  // When both "none" and "header" are offered, collapse them into a single
  // UI surface: the empty CardStack is the "none" state, and adding a header
  // transitions `value` to "header" automatically.
  const unifiesHeaders = methods.includes("none") && methods.includes("header");
  const displayMethods = unifiesHeaders ? methods.filter((m) => m !== "none") : methods;
  const displayValue: AuthMethod = unifiesHeaders && value === "none" ? "header" : value;

  const showHeaders = value === "header" || (unifiesHeaders && value === "none");
  const canAddMore = !singleHeader || headers.length === 0;

  const addHeaderFromPreset = (preset: HeaderAuthPreset) => {
    onHeadersChange?.([
      ...headers,
      {
        name: preset.name,
        prefix: preset.prefix,
        presetKey: preset.key,
        secretId: null,
      },
    ]);
    setPicking(false);
    if (unifiesHeaders && value === "none") {
      onChange("header");
    }
  };

  const updateHeader = (
    index: number,
    update: Partial<{
      name: string;
      secretId: string | null;
      prefix?: string;
      presetKey?: string;
    }>,
  ) => {
    onHeadersChange?.(headers.map((entry, i) => (i === index ? { ...entry, ...update } : entry)));
  };

  const removeHeader = (index: number) => {
    const next = headers.filter((_, i) => i !== index);
    onHeadersChange?.(next);
    if (unifiesHeaders && next.length === 0) {
      onChange("none");
    }
  };

  return (
    <section className="space-y-2.5">
      {displayMethods.length > 1 ? (
        <div className="flex items-center justify-between gap-3">
          <FieldLabel>{label}</FieldLabel>
          <FilterTabs<AuthMethod>
            tabs={displayMethods.map((method) => ({
              value: method,
              label: getMethodLabel(method),
            }))}
            value={displayValue}
            onChange={onChange}
          />
        </div>
      ) : (
        <FieldLabel>{label}</FieldLabel>
      )}

      {showHeaders && (
        <CardStack>
          <CardStackContent className="[&>*+*]:before:inset-x-0">
            {picking ? (
              <HeaderPresetPicker onPick={addHeaderFromPreset} onCancel={() => setPicking(false)} />
            ) : headers.length === 0 ? (
              canAddMore ? (
                <AddHeaderRow leading={<span>No headers</span>} onClick={() => setPicking(true)} />
              ) : (
                <CardStackEmpty>
                  <span>No headers</span>
                </CardStackEmpty>
              )
            ) : (
              <>
                {headers.map((header, index) => (
                  <SecretHeaderAuthRow
                    key={index}
                    name={header.name}
                    prefix={header.prefix}
                    presetKey={header.presetKey}
                    secretId={header.secretId}
                    onChange={(update) => updateHeader(index, update)}
                    onSelectSecret={(secretId) => updateHeader(index, { secretId })}
                    onRemove={singleHeader ? undefined : () => removeHeader(index)}
                    existingSecrets={existingSecrets}
                  />
                ))}
                {canAddMore && <AddHeaderRow onClick={() => setPicking(true)} />}
              </>
            )}
          </CardStackContent>
        </CardStack>
      )}

      {value === "oauth2" && oauth2Slot}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Internal sub-components
// ---------------------------------------------------------------------------

interface AddHeaderRowProps {
  readonly onClick: () => void;
  readonly leading?: ReactNode;
}

function AddHeaderRow({ onClick, leading }: AddHeaderRowProps) {
  return (
    // oxlint-disable-next-line react/forbid-elements
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label="Add header"
      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-sm text-muted-foreground outline-none transition-[background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-accent/40 focus-visible:bg-accent/40"
    >
      <span className="min-w-0 flex-1 text-left">{leading}</span>
      <PlusIcon aria-hidden className="size-4 shrink-0" />
    </button>
  );
}

interface HeaderPresetPickerProps {
  readonly onPick: (preset: HeaderAuthPreset) => void;
  readonly onCancel: () => void;
}

function HeaderPresetPicker({ onPick, onCancel }: HeaderPresetPickerProps) {
  return (
    <CardStackEntry className="flex-wrap gap-2">
      {defaultHeaderAuthPresets.map((preset) => (
        <Button
          key={preset.key}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPick(preset)}
        >
          {preset.label}
        </Button>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onCancel}
        className="text-muted-foreground"
      >
        Cancel
      </Button>
    </CardStackEntry>
  );
}

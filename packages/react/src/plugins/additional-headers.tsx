import type { ReactNode } from "react";

import {
  CardStack,
  CardStackContent,
  CardStackEntry,
} from "../components/card-stack";
import { Label } from "../components/label";
import { Button } from "../components/button";
import { Input } from "../components/input";
import {
  headerValueToState,
  headersFromState,
  type HeaderState,
} from "./secret-header-auth";

export type PlainHeader = {
  readonly name: string;
  readonly value: string;
};

type SharedHeaderValue = string | { readonly secretId: string; readonly prefix?: string };

export function partitionHeaders(
  headers: Record<string, SharedHeaderValue> | undefined,
): {
  readonly authHeaders: HeaderState[];
  readonly additionalHeaders: PlainHeader[];
} {
  const authHeaders: HeaderState[] = [];
  const additionalHeaders: PlainHeader[] = [];

  for (const [name, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") {
      additionalHeaders.push({ name, value });
      continue;
    }
    authHeaders.push(headerValueToState(name, value));
  }

  return { authHeaders, additionalHeaders };
}

export function mergeHeaders(
  authHeaders: readonly HeaderState[],
  additionalHeaders: readonly PlainHeader[],
): Record<string, SharedHeaderValue> {
  const merged: Record<string, SharedHeaderValue> = {
    ...headersFromState(authHeaders),
  };

  for (const header of additionalHeaders) {
    const name = header.name.trim();
    const value = header.value.trim();
    if (!name || !value) continue;
    merged[name] = value;
  }

  return merged;
}

export function validateHeaderConfiguration(args: {
  readonly authHeaders: readonly HeaderState[];
  readonly additionalHeaders: readonly PlainHeader[];
  readonly reserveAuthorization?: boolean;
}): string | null {
  const names = new Map<string, string>();

  const noteName = (rawName: string) => {
    const trimmed = rawName.trim();
    if (!trimmed) return null;
    const normalized = trimmed.toLowerCase();
    if (args.reserveAuthorization && normalized === "authorization") {
      return "Authorization header is managed by OAuth and can't be set manually.";
    }
    const existing = names.get(normalized);
    if (existing) {
      return "Header names must be unique across authentication and additional headers.";
    }
    names.set(normalized, trimmed);
    return null;
  };

  for (const header of args.authHeaders) {
    const error = noteName(header.name);
    if (error) return error;
  }

  for (const header of args.additionalHeaders) {
    if (!header.name.trim() || !header.value.trim()) {
      return "Additional headers require both a name and value.";
    }
    const error = noteName(header.name);
    if (error) return error;
  }

  return null;
}

export function AdditionalHeadersSection(props: {
  readonly headers: readonly PlainHeader[];
  readonly onHeadersChange: (headers: PlainHeader[]) => void;
  readonly error?: string | null;
  readonly label?: string;
  readonly description?: ReactNode;
  readonly emptyLabel?: ReactNode;
}) {
  const {
    headers,
    onHeadersChange,
    error = null,
    label = "Additional headers",
    description = (
      <>
        Plaintext headers sent with every request. Use authentication for secret-backed auth
        headers.
      </>
    ),
    emptyLabel = "No headers",
  } = props;

  const updateHeader = (index: number, update: Partial<PlainHeader>) => {
    onHeadersChange(headers.map((entry, i) => (i === index ? { ...entry, ...update } : entry)));
  };

  const removeHeader = (index: number) => {
    onHeadersChange(headers.filter((_, i) => i !== index));
  };

  const addHeader = () => {
    onHeadersChange([...headers, { name: "", value: "" }]);
  };

  return (
    <section className="space-y-2.5">
      <div>
        <Label>{label}</Label>
        <p className="mt-1 text-[12px] text-muted-foreground">{description}</p>
      </div>

      <CardStack>
        <CardStackContent>
          {headers.length === 0 ? (
            <AddPlainHeaderRow leading={<span>{emptyLabel}</span>} onClick={addHeader} />
          ) : (
            <>
              {headers.map((header, index) => (
                <CardStackEntry key={index} className="flex-col items-stretch gap-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Header
                    </Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeHeader(index)}
                    >
                      Remove
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Name
                      </Label>
                      <Input
                        value={header.name}
                        onChange={(event) =>
                          updateHeader(index, {
                            name: (event.target as HTMLInputElement).value,
                          })
                        }
                        placeholder="X-Organization-Id"
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        Value
                      </Label>
                      <Input
                        value={header.value}
                        onChange={(event) =>
                          updateHeader(index, {
                            value: (event.target as HTMLInputElement).value,
                          })
                        }
                        placeholder="workspace-id"
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                  </div>
                </CardStackEntry>
              ))}
              <AddPlainHeaderRow onClick={addHeader} />
            </>
          )}
        </CardStackContent>
      </CardStack>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-[12px] text-destructive">{error}</p>
        </div>
      )}
    </section>
  );
}

function AddPlainHeaderRow(props: {
  readonly onClick: () => void;
  readonly leading?: ReactNode;
}) {
  return (
    // oxlint-disable-next-line react/forbid-elements
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      aria-label="Add header"
      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-sm text-muted-foreground outline-none transition-[background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-accent/40 focus-visible:bg-accent/40"
    >
      <span className="min-w-0 flex-1 text-left">{props.leading}</span>
      <svg aria-hidden viewBox="0 0 16 16" fill="none" className="size-4 shrink-0">
        <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );
}

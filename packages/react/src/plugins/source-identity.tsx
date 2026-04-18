import { useCallback, useState } from "react";
import { parse } from "tldts";

import {
  CardStack,
  CardStackContent,
  CardStackEntryField,
} from "../components/card-stack";
import { Input } from "../components/input";
import { normalizeNamespaceInput, slugifyNamespace } from "./namespace";
export { normalizeNamespaceInput, slugifyNamespace } from "./namespace";

/**
 * Derives a display-name candidate from a URL by extracting its apex domain
 * label (e.g. `https://api.shopify.com/graphql` → `"Shopify"`) and
 * title-casing it. Returns `null` if the URL has no parseable domain.
 */
export function displayNameFromUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const parsed = parse(trimmed);
  const label = parsed.domainWithoutSuffix;
  if (!label) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// ---------------------------------------------------------------------------
// Hook — owns the name + namespace state with namespace auto-derivation
// ---------------------------------------------------------------------------

export interface SourceIdentity {
  /** Display name — the user's override if they've typed one, otherwise the fallback. */
  readonly name: string;
  /** Namespace — the user's override if they've typed one, otherwise slugified from `name`. */
  readonly namespace: string;
  /**
   * `true` when the user has explicitly typed a name (i.e. the current
   * `name` came from `setName`, not the fallback). Useful for "only prefill
   * once" logic so the caller doesn't clobber a user-entered value when the
   * fallback later changes.
   */
  readonly userProvidedName: boolean;
  /**
   * `true` when the user has explicitly typed a namespace (i.e. the current
   * `namespace` came from `setNamespace`, not the slug-of-name fallback).
   */
  readonly userProvidedNamespace: boolean;
  readonly setName: (name: string) => void;
  readonly setNamespace: (namespace: string) => void;
  /** Clears any user overrides so both fields return to deriving from the fallback. */
  readonly reset: () => void;
}

export interface UseSourceIdentityOptions {
  /**
   * Fallback display name — used when the user hasn't typed one. Pass a
   * value computed from the caller's reactive state (probe result, URL
   * apex domain, template default, etc.) and it'll flow through to `name`
   * automatically.
   */
  readonly fallbackName?: string;
  /** Fallback namespace — defaults to `slugifyNamespace(fallbackName ?? "")`. */
  readonly fallbackNamespace?: string;
}

/**
 * Manages a display name and a derived namespace. Both fields are pure
 * derived state: the user's `setName` / `setNamespace` call stores an
 * override, otherwise the hook returns the caller-supplied fallback
 * (passed fresh on every render). Call `reset()` to drop overrides.
 *
 * The returned `userProvidedName` / `userProvidedNamespace` booleans
 * expose whether the user has explicitly typed into each field — callers
 * use these flags to decide whether it's safe to auto-populate the field
 * from a newly-available fallback without clobbering user intent.
 */
export function useSourceIdentity(options?: UseSourceIdentityOptions): SourceIdentity {
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [namespaceOverride, setNamespaceOverride] = useState<string | null>(null);

  const fallbackName = options?.fallbackName ?? "";
  const name = nameOverride ?? fallbackName;
  const fallbackNamespace = options?.fallbackNamespace ?? slugifyNamespace(name);
  const namespace = namespaceOverride ?? fallbackNamespace;

  const setName = useCallback((next: string) => {
    setNameOverride(next);
  }, []);

  const setNamespace = useCallback((next: string) => {
    setNamespaceOverride(normalizeNamespaceInput(next));
  }, []);

  const reset = useCallback(() => {
    setNameOverride(null);
    setNamespaceOverride(null);
  }, []);

  return {
    name,
    namespace,
    userProvidedName: nameOverride !== null,
    userProvidedNamespace: namespaceOverride !== null,
    setName,
    setNamespace,
    reset,
  };
}

// ---------------------------------------------------------------------------
// UI — two fields, wrapped in a shared CardStack
// ---------------------------------------------------------------------------

export interface SourceIdentityFieldsProps {
  readonly identity: SourceIdentity;
  readonly namePlaceholder?: string;
  readonly namespacePlaceholder?: string;
  readonly nameLabel?: string;
  readonly namespaceHint?: string;
  /**
   * When true, the namespace field is rendered disabled — useful on Edit
   * forms, where the namespace is the source's identity and changing it
   * would require a delete + recreate flow.
   */
  readonly namespaceReadOnly?: boolean;
  /** Optional endpoint URL field rendered as the first row in the card stack. */
  readonly endpoint?: string;
  readonly onEndpointChange?: (endpoint: string) => void;
  readonly endpointLabel?: string;
  readonly endpointPlaceholder?: string;
  /** Clickable endpoint presets shown below the label (e.g. server environments from the spec). */
  readonly endpointHints?: readonly { label: string; url: string }[];
  /** Extra content rendered below the endpoint input, inside the same card (e.g. error messages). */
  readonly endpointExtra?: React.ReactNode;
  /** Content rendered inline next to the endpoint label (e.g. loading spinner). */
  readonly endpointLabelAction?: React.ReactNode;
  /** Content rendered as the first row(s) in the card stack, before the endpoint field. */
  readonly prepend?: React.ReactNode;
}

export function SourceIdentityFields({
  identity,
  namePlaceholder = "e.g. Sentry API",
  namespacePlaceholder = "sentry_api",
  nameLabel = "Name",
  namespaceHint,
  namespaceReadOnly = false,
  endpoint,
  onEndpointChange,
  endpointLabel = "URL",
  endpointPlaceholder = "https://api.example.com",
  endpointHints,
  endpointExtra,
  endpointLabelAction,
  prepend,
}: SourceIdentityFieldsProps) {
  const hasEndpoint = endpoint !== undefined && onEndpointChange !== undefined;

  return (
    <CardStack>
      <CardStackContent className="border-t-0">
        {prepend}
        {hasEndpoint && (
          <>
            <CardStackEntryField
              labelAction={endpointLabelAction}
              label={
                <div>
                  <span>{endpointLabel}</span>
                  {endpointHints && endpointHints.length > 0 && (
                    <div className="mt-0.5 text-xs font-normal text-muted-foreground">
                      {"Use "}
                      {endpointHints.map((hint, i) => (
                        <span key={hint.url}>
                          {i > 0 && ", "}
                          {/* oxlint-disable-next-line react/forbid-elements */}
                          <button
                            type="button"
                            className="underline text-muted-foreground hover:text-foreground"
                            onClick={() => onEndpointChange(hint.url)}
                          >
                            {hint.label}
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              }
            >
              <Input
                value={endpoint}
                onChange={(e) => onEndpointChange((e.target as HTMLInputElement).value)}
                placeholder={endpointPlaceholder}
                className="w-full font-mono text-sm"
              />
              {endpointExtra}
            </CardStackEntryField>
          </>
        )}
        <CardStackEntryField
          label={nameLabel}
          labelAction={
            <Input
              value={identity.name}
              onChange={(e) => identity.setName((e.target as HTMLInputElement).value)}
              placeholder={namePlaceholder}
              className="w-56 text-sm"
            />
          }
        />
        <CardStackEntryField
          label={
            <div>
              <span>Namespace</span>
              <div className="mt-0.5 text-xs font-normal text-muted-foreground">
                e.g. <code className="font-mono text-foreground/70">{identity.namespace || namespacePlaceholder}.list_users</code>
              </div>
            </div>
          }
          labelAction={
            <Input
              value={identity.namespace}
              onChange={(e) => identity.setNamespace((e.target as HTMLInputElement).value)}
              placeholder={namespacePlaceholder}
              className="w-56 font-mono text-sm"
              disabled={namespaceReadOnly}
            />
          }
        />
      </CardStackContent>
    </CardStack>
  );
}

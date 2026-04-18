"use client";

import { type ReactNode, useMemo } from "react";
import { PlusIcon } from "lucide-react";

import { Button } from "../components/button";
import { CardStack, CardStackContent, CardStackHeader } from "../components/card-stack";
import { Input } from "../components/input";
import { NativeSelect, NativeSelectOption } from "../components/native-select";
import { Spinner } from "../components/spinner";
import { SecretPicker, type SecretPickerSecret } from "./secret-picker";
import { KeyValueList, type KeyValueEntry, newKeyValueEntry } from "./key-value-list";

// ---------------------------------------------------------------------------
// Auth mode types
// ---------------------------------------------------------------------------

export type AuthMode = "none" | "basic" | "apikey" | "bearer" | "oauth";

export type OAuthStatus =
  | { step: "idle" }
  | { step: "starting" }
  | { step: "waiting" }
  | { step: "authenticated" }
  | { step: "error"; message: string };

// ---------------------------------------------------------------------------
// SourceConfig props
// ---------------------------------------------------------------------------

export interface SourceConfigProps {
  // ── Authorization ───────────────────────────────────────────────────
  /** Currently selected auth mode. */
  authMode: AuthMode;
  onAuthModeChange: (mode: AuthMode) => void;
  /**
   * Restrict which auth modes are shown. Defaults to all. If a mode is
   * omitted here, its config panel will never render — and its handler
   * props are therefore not required.
   */
  allowedAuthModes?: readonly AuthMode[];
  /** Auth modes to render disabled in the sidebar (not selectable). */
  disabledAuthModes?: readonly AuthMode[];

  // Bearer
  bearerSecretId?: string | null;
  onBearerSecretChange?: (secretId: string) => void;

  // Basic Auth
  basicUsername?: string;
  onBasicUsernameChange?: (username: string) => void;
  basicSecretId?: string | null;
  onBasicSecretChange?: (secretId: string) => void;

  // API Key
  apiKeyName?: string;
  onApiKeyNameChange?: (name: string) => void;
  apiKeySecretId?: string | null;
  onApiKeySecretChange?: (secretId: string) => void;
  apiKeyLocation?: "header" | "query";
  onApiKeyLocationChange?: (location: "header" | "query") => void;

  // OAuth
  oauthStatus?: OAuthStatus;
  onOAuthSignIn?: () => void;
  onOAuthCancel?: () => void;
  /** Called when the user wants to sign out of an authenticated OAuth session. */
  onOAuthSignOut?: () => void;
  /** Extra content rendered inside the OAuth panel (below the status UI). */
  oauthExtra?: ReactNode;

  // ── Headers ─────────────────────────────────────────────────────────
  headers?: readonly KeyValueEntry[];
  onHeadersChange?: (headers: readonly KeyValueEntry[]) => void;

  // ── Shared ──────────────────────────────────────────────────────────
  /** Existing secrets list, surfaced to any nested picker that needs it. */
  secrets?: readonly SecretPickerSecret[];
}

// ---------------------------------------------------------------------------
// Auth mode definitions
// ---------------------------------------------------------------------------

const ALL_AUTH_MODES: { value: AuthMode; label: string }[] = [
  { value: "none", label: "No Auth" },
  { value: "basic", label: "Basic Auth" },
  { value: "apikey", label: "API Key" },
  { value: "bearer", label: "Bearer Token" },
  { value: "oauth", label: "OAuth 2.0" },
];

export type ApiKeyLocation = "header" | "query";

const API_KEY_LOCATIONS: { value: ApiKeyLocation; label: string }[] = [
  { value: "header", label: "Header" },
  { value: "query", label: "Query Parameter" },
];

// ---------------------------------------------------------------------------
// Add button for card stack headers
// ---------------------------------------------------------------------------

function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-xs" type="button" onClick={onClick} aria-label="Add">
      <PlusIcon className="size-4" />
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Labeled SecretPicker — shared by the three auth panels (Basic, API key, Bearer).
// ---------------------------------------------------------------------------

function SecretField(props: {
  label: string;
  value: string | null;
  onSelect: (secretId: string) => void;
  secrets: readonly SecretPickerSecret[];
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm text-muted-foreground">{props.label}</label>
      <SecretPicker
        value={props.value}
        onSelect={props.onSelect}
        secrets={props.secrets}
        placeholder={props.placeholder ?? "Select a secret..."}
        showChevron
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SourceConfig({
  authMode,
  onAuthModeChange,
  allowedAuthModes,
  disabledAuthModes,
  bearerSecretId,
  onBearerSecretChange,
  basicUsername = "",
  onBasicUsernameChange,
  basicSecretId,
  onBasicSecretChange,
  apiKeyName = "",
  onApiKeyNameChange,
  apiKeySecretId,
  onApiKeySecretChange,
  apiKeyLocation = "header",
  onApiKeyLocationChange,
  oauthStatus = { step: "idle" },
  onOAuthSignIn,
  onOAuthCancel,
  onOAuthSignOut,
  oauthExtra,
  headers = [],
  onHeadersChange,
  secrets = [],
}: SourceConfigProps) {
  const addHeader = () =>
    onHeadersChange?.([...headers, newKeyValueEntry()]);

  const visibleModes = useMemo(
    () =>
      allowedAuthModes
        ? ALL_AUTH_MODES.filter((m) => allowedAuthModes.includes(m.value))
        : ALL_AUTH_MODES,
    [allowedAuthModes],
  );
  const disabledSet = useMemo(
    () => new Set<AuthMode>(disabledAuthModes ?? []),
    [disabledAuthModes],
  );

  return (
    <div className="space-y-6">
      {/* Authorization */}
      <CardStack>
        <CardStackHeader
          rightSlot={
            <NativeSelect
              size="sm"
              value={authMode}
              onChange={(e) =>
                onAuthModeChange(
                  (e.target as HTMLSelectElement).value as AuthMode,
                )
              }
              data-testid="auth-mode-select"
            >
              {visibleModes.map((mode) => (
                <NativeSelectOption
                  key={mode.value}
                  value={mode.value}
                  disabled={
                    disabledSet.has(mode.value) && authMode !== mode.value
                  }
                >
                  {mode.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          }
        >
          Authorization
        </CardStackHeader>
        <CardStackContent>
          <div className="p-4">
            {authMode === "none" && <NoAuthPanel />}

            {authMode === "basic" && onBasicSecretChange && onBasicUsernameChange && (
              <BasicAuthPanel
                username={basicUsername}
                onUsernameChange={onBasicUsernameChange}
                secretId={basicSecretId ?? null}
                onSecretChange={onBasicSecretChange}
                secrets={secrets}
              />
            )}

            {authMode === "apikey" && onApiKeySecretChange && onApiKeyNameChange && onApiKeyLocationChange && (
              <ApiKeyPanel
                name={apiKeyName}
                onNameChange={onApiKeyNameChange}
                secretId={apiKeySecretId ?? null}
                onSecretChange={onApiKeySecretChange}
                location={apiKeyLocation}
                onLocationChange={onApiKeyLocationChange}
                secrets={secrets}
              />
            )}

            {authMode === "bearer" && onBearerSecretChange && (
              <BearerTokenPanel
                secretId={bearerSecretId ?? null}
                onSecretChange={onBearerSecretChange}
                secrets={secrets}
              />
            )}

            {authMode === "oauth" && (
              <OAuthPanel
                status={oauthStatus}
                onSignIn={onOAuthSignIn}
                onCancel={onOAuthCancel}
                onSignOut={onOAuthSignOut}
                extra={oauthExtra}
              />
            )}
          </div>
        </CardStackContent>
      </CardStack>

      {/* Headers — only rendered when the caller wants to manage headers */}
      {onHeadersChange && (
        <CardStack>
          <CardStackHeader rightSlot={<AddButton onClick={addHeader} />}>
            Headers
          </CardStackHeader>
          <CardStackContent>
            <KeyValueList
              entries={headers}
              onChange={onHeadersChange}
              secrets={secrets}
              emptyLabel="No headers"
              keyPlaceholder="Header-Name"
              valuePlaceholder="value"
            />
          </CardStackContent>
        </CardStack>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// No Auth panel
// ---------------------------------------------------------------------------

function NoAuthPanel() {
  return (
    <p className="text-sm/6 text-muted-foreground text-pretty">
      No authentication will be used for requests to this source.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Basic Auth panel
// ---------------------------------------------------------------------------

function BasicAuthPanel(props: {
  username: string;
  onUsernameChange: (username: string) => void;
  secretId: string | null;
  onSecretChange: (secretId: string) => void;
  secrets: readonly SecretPickerSecret[];
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm/6 text-muted-foreground text-pretty">
        A Basic Authentication header will be generated from the username and password.
      </p>
      <div className="space-y-1.5">
        <label className="text-sm text-muted-foreground">Username</label>
        <Input
          value={props.username}
          onChange={(e) => props.onUsernameChange((e.target as HTMLInputElement).value)}
          placeholder="username"
          className="text-sm"
        />
      </div>
      <SecretField
        label="Password"
        value={props.secretId}
        onSelect={props.onSecretChange}
        secrets={props.secrets}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// API Key panel
// ---------------------------------------------------------------------------

function ApiKeyPanel(props: {
  name: string;
  onNameChange: (name: string) => void;
  secretId: string | null;
  onSecretChange: (secretId: string) => void;
  location: "header" | "query";
  onLocationChange: (location: "header" | "query") => void;
  secrets: readonly SecretPickerSecret[];
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm/6 text-muted-foreground text-pretty">
        An API key will be sent as a header or query parameter with each request.
      </p>
      <div className="space-y-1.5">
        <label className="text-sm text-muted-foreground">Key</label>
        <Input
          value={props.name}
          onChange={(e) => props.onNameChange((e.target as HTMLInputElement).value)}
          placeholder="X-API-Key"
          className="font-mono text-sm"
        />
      </div>
      <SecretField
        label="Value"
        value={props.secretId}
        onSelect={props.onSecretChange}
        secrets={props.secrets}
      />
      <div className="space-y-1.5">
        <label className="text-sm text-muted-foreground">Add to</label>
        <NativeSelect
          value={props.location}
          onChange={(e) =>
            props.onLocationChange((e.target as HTMLSelectElement).value as "header" | "query")
          }
          size="sm"
          className="text-sm"
        >
          {API_KEY_LOCATIONS.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bearer Token panel
// ---------------------------------------------------------------------------

function BearerTokenPanel(props: {
  secretId: string | null;
  onSecretChange: (secretId: string) => void;
  secrets: readonly SecretPickerSecret[];
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm/6 text-muted-foreground text-pretty">
        The authorization header will be automatically generated when you send the request.
        The token is stored as a secret and never exposed in plaintext.
      </p>
      <SecretField
        label="Token"
        value={props.secretId}
        onSelect={props.onSecretChange}
        secrets={props.secrets}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// OAuth panel
// ---------------------------------------------------------------------------

function OAuthPanel(props: {
  status: OAuthStatus;
  onSignIn?: () => void;
  onCancel?: () => void;
  onSignOut?: () => void;
  extra?: ReactNode;
}) {
  const { status, onSignIn, onCancel, onSignOut, extra } = props;

  const description = (
    <p className="text-sm/6 text-muted-foreground text-pretty">
      Sign in via your provider's OAuth flow. Tokens are securely stored and
      automatically refreshed when they expire.
    </p>
  );

  let content: ReactNode;

  if (status.step === "authenticated") {
    content = (
      <div className="flex items-center gap-2 rounded-md ring-1 ring-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
        <svg viewBox="0 0 16 16" fill="none" className="size-4 shrink-0 stroke-emerald-500">
          <path
            d="M3 8.5l3 3 7-7"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="text-sm text-emerald-600 dark:text-emerald-400">
          Authenticated
        </span>
        {onSignOut && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onSignOut}
            className="ml-auto py-1 px-2 text-sm"
          >
            Sign out
          </Button>
        )}
      </div>
    );
  } else if (status.step === "starting") {
    content = (
      <div className="flex items-center gap-2 rounded-md ring-1 ring-black/5 dark:ring-white/10 px-3 py-2.5">
        <Spinner className="size-4 shrink-0" />
        <span className="text-sm text-muted-foreground">Starting authorization...</span>
      </div>
    );
  } else if (status.step === "waiting") {
    content = (
      <div className="flex items-center gap-2 rounded-md ring-1 ring-blue-500/20 bg-blue-500/5 px-3 py-2.5">
        <Spinner className="size-4 shrink-0 text-blue-500" />
        <span className="text-sm text-blue-600 dark:text-blue-400">
          Waiting for authorization in popup...
        </span>
        {onCancel && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            className="ml-auto py-1 px-2 text-sm"
          >
            Cancel
          </Button>
        )}
      </div>
    );
  } else if (status.step === "error") {
    content = (
      <div className="space-y-2">
        <div className="rounded-md ring-1 ring-destructive/20 bg-destructive/5 px-3 py-2.5">
          <p className="text-sm text-destructive">{status.message}</p>
        </div>
        {onSignIn && (
          <Button onClick={onSignIn} variant="outline" size="sm">
            Try again
          </Button>
        )}
      </div>
    );
  } else {
    content = (
      <Button onClick={onSignIn} variant="outline" type="button">
        Sign in
      </Button>
    );
  }

  return (
    <div className="space-y-3">
      {description}
      {content}
      {extra}
    </div>
  );
}

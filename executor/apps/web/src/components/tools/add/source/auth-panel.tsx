import { AlertTriangle, KeyRound, Loader2, LockKeyhole, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { InferredSpecAuth } from "@/lib/openapi/spec-inspector";
import type { CredentialScope, SourceAuthType } from "@/lib/types";
import type { SourceType } from "./dialog-helpers";

export type SourceAuthPanelEditableField =
  | "apiKeyHeader"
  | "tokenValue"
  | "apiKeyValue"
  | "basicUsername"
  | "basicPassword";

type SharingScope = "only_me" | "workspace" | "organization";

function sharingScopeFromModel(model: Pick<SourceAuthPanelModel, "scopeType" | "authScope">): SharingScope {
  if (model.authScope === "account") {
    return "only_me";
  }
  return model.scopeType === "organization" ? "organization" : "workspace";
}

export type SourceAuthPanelModel = {
  sourceType: SourceType;
  specStatus: "idle" | "detecting" | "ready" | "error";
  inferredSpecAuth: InferredSpecAuth | null;
  specError: string;
  mcpOAuthStatus: "idle" | "checking" | "oauth" | "none" | "error";
  mcpOAuthDetail: string;
  mcpOAuthAuthorizationServers: string[];
  mcpOAuthConnected: boolean;
  authType: Exclude<SourceAuthType, "mixed">;
  scopeType: "organization" | "workspace";
  authScope: CredentialScope;
  apiKeyHeader: string;
  tokenValue: string;
  apiKeyValue: string;
  basicUsername: string;
  basicPassword: string;
  useCredentialedFetch: boolean;
  hasExistingCredential: boolean;
};

function inferredAuthBadge(inferredSpecAuth: InferredSpecAuth | null): string | null {
  if (!inferredSpecAuth) {
    return null;
  }
  if (inferredSpecAuth.type === "mixed") {
    return "Mixed auth";
  }
  if (inferredSpecAuth.type === "apiKey") {
    return `API key${inferredSpecAuth.header ? ` (${inferredSpecAuth.header})` : ""}`;
  }
  if (inferredSpecAuth.type === "basic") {
    return "Basic";
  }
  if (inferredSpecAuth.type === "bearer") {
    return "Bearer";
  }
  return null;
}

export function SourceAuthPanel({
  model,
  onAuthTypeChange,
  onScopeChange,
  onFieldChange,
  onUseCredentialedFetchChange,
  onMcpOAuthConnect,
  onOpenApiSpecRetry,
  openApiSpecRetrying = false,
  mcpOAuthBusy = false,
  sourceInfoLoading = false,
}: {
  model: SourceAuthPanelModel;
  onAuthTypeChange: (value: Exclude<SourceAuthType, "mixed">) => void;
  onScopeChange: (value: SharingScope) => void;
  onFieldChange: (field: SourceAuthPanelEditableField, value: string) => void;
  onUseCredentialedFetchChange: (enabled: boolean) => void;
  onMcpOAuthConnect?: () => void;
  onOpenApiSpecRetry?: () => void;
  openApiSpecRetrying?: boolean;
  mcpOAuthBusy?: boolean;
  /** True while spec/OAuth detection is in progress */
  sourceInfoLoading?: boolean;
}) {
  const {
    sourceType,
    specStatus,
    inferredSpecAuth,
    specError,
    mcpOAuthStatus,
    mcpOAuthDetail,
    mcpOAuthConnected,
    authType,
    apiKeyHeader,
    tokenValue,
    apiKeyValue,
    basicUsername,
    basicPassword,
    useCredentialedFetch,
    hasExistingCredential,
  } = model;

  // Check whether the user has entered any credential values for the current auth type.
  const credentialsFilled = authType === "bearer"
    ? tokenValue.trim().length > 0
    : authType === "apiKey"
      ? apiKeyValue.trim().length > 0
      : authType === "basic"
        ? basicUsername.trim().length > 0 || basicPassword.trim().length > 0
        : false;
  const sharingScope = sharingScopeFromModel(model);

  if (sourceType !== "openapi" && sourceType !== "graphql" && sourceType !== "mcp") {
    return null;
  }

  const badge = inferredAuthBadge(inferredSpecAuth);
  const mcpBearerConnected = sourceType === "mcp" && authType === "bearer" && mcpOAuthConnected;
  const mcpOAuthLoading = sourceType === "mcp" && mcpOAuthStatus === "checking";
  const mcpOAuthDetected = sourceType === "mcp" && mcpOAuthStatus === "oauth";
  const useMcpOAuthFlow = mcpOAuthLoading || mcpOAuthDetected;
  return (
    <div className="space-y-3">

      {sourceType === "openapi" && specStatus === "detecting" ? (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Detecting auth from spec…
        </div>
      ) : null}

      {sourceType === "openapi" && specStatus === "ready" && badge ? (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          Detected: <span className="font-medium text-foreground/80">{badge}</span>
        </div>
      ) : null}

      {sourceType === "openapi" && specError ? (
        <div className="flex items-start justify-between gap-2 rounded-md border border-terminal-amber/30 bg-terminal-amber/5 px-2.5 py-2">
          <p className="text-[10px] text-terminal-amber/95 leading-relaxed">{specError}</p>
          {onOpenApiSpecRetry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10px] shrink-0"
              disabled={openApiSpecRetrying}
              onClick={onOpenApiSpecRetry}
            >
              {openApiSpecRetrying ? "Retrying..." : "Retry"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {sourceType === "openapi" && specStatus !== "idle" && !sourceInfoLoading ? (
        <p className="text-[10px] text-muted-foreground">
          Spec check reruns automatically when auth values change. You can also retry manually.
        </p>
      ) : null}

      <label className="flex items-center gap-2 rounded-md border border-border/50 bg-background/40 px-2.5 py-2">
        <input
          type="checkbox"
          checked={useCredentialedFetch}
          onChange={(event) => onUseCredentialedFetchChange(event.target.checked)}
          className="h-3.5 w-3.5"
        />
        <span className="text-[11px] text-muted-foreground">
          Use credentials while fetching source metadata
        </span>
      </label>

      {sourceType === "mcp" && mcpOAuthStatus === "checking" ? (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Checking for OAuth…
        </div>
      ) : null}

      {sourceType === "mcp" && mcpOAuthStatus === "error" && mcpOAuthDetail ? (
        <p className="text-[10px] text-terminal-amber">{mcpOAuthDetail}</p>
      ) : null}

      {sourceInfoLoading ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Auth Type</Label>
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Scope</Label>
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
        </div>
      ) : (
        <div className={`grid ${useMcpOAuthFlow ? "grid-cols-1" : "grid-cols-2"} gap-3`}>
          {!useMcpOAuthFlow ? (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Auth Type</Label>
              <Select value={authType} onValueChange={(value) => onAuthTypeChange(value as Exclude<SourceAuthType, "mixed">)}>
                <SelectTrigger className="h-8 text-xs bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" className="text-xs">None</SelectItem>
                  <SelectItem value="bearer" className="text-xs">Bearer token</SelectItem>
                  <SelectItem value="apiKey" className="text-xs">API key header</SelectItem>
                  <SelectItem value="basic" className="text-xs">Basic auth</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Scope</Label>
            <Select
              value={sharingScope}
              onValueChange={(value) => onScopeChange(value as SharingScope)}
              disabled={authType === "none"}
            >
              <SelectTrigger className="h-8 text-xs bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="only_me" className="text-xs">Only me</SelectItem>
                <SelectItem value="workspace" className="text-xs">Workspace</SelectItem>
                <SelectItem value="organization" className="text-xs">Organization</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {sourceType === "mcp" && useMcpOAuthFlow && onMcpOAuthConnect ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">OAuth</Label>
            {mcpBearerConnected ? (
              <Badge variant="outline" className="text-[10px] uppercase tracking-wider text-terminal-green">
                Connected
              </Badge>
            ) : null}
          </div>
          {mcpOAuthLoading ? (
            <Skeleton className="h-8 w-full" />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={mcpOAuthBusy}
              onClick={onMcpOAuthConnect}
            >
              {mcpOAuthBusy ? "Connecting..." : mcpBearerConnected ? "Reconnect OAuth" : "Connect OAuth in popup"}
            </Button>
          )}
          {mcpBearerConnected ? (
            <p className="text-[11px] text-muted-foreground">OAuth linked successfully.</p>
          ) : null}
        </div>
      ) : null}

      {authType === "apiKey" ? (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">API Key Header</Label>
          <Input
            value={apiKeyHeader}
            onChange={(event) => onFieldChange("apiKeyHeader", event.target.value)}
            placeholder="x-api-key"
            className="h-8 text-xs font-mono bg-background"
          />
        </div>
      ) : null}

      {authType === "bearer" && !useMcpOAuthFlow && !mcpBearerConnected ? (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
            <LockKeyhole className="h-3 w-3" />
            Bearer Token
          </Label>
          <Input
            type="password"
            value={tokenValue}
            onChange={(event) => onFieldChange("tokenValue", event.target.value)}
            placeholder={hasExistingCredential ? "Leave blank to keep saved token" : "tok_..."}
            className="h-8 text-xs font-mono bg-background"
          />
        </div>
      ) : null}

      {authType === "apiKey" && !useMcpOAuthFlow ? (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
            <KeyRound className="h-3 w-3" />
            API Key Value
          </Label>
          <Input
            type="password"
            value={apiKeyValue}
            onChange={(event) => onFieldChange("apiKeyValue", event.target.value)}
            placeholder={hasExistingCredential ? "Leave blank to keep saved key" : "sk_live_..."}
            className="h-8 text-xs font-mono bg-background"
          />
        </div>
      ) : null}

      {authType === "basic" && !useMcpOAuthFlow ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
              <UserRound className="h-3 w-3" />
              Username
            </Label>
            <Input
              value={basicUsername}
              onChange={(event) => onFieldChange("basicUsername", event.target.value)}
              placeholder={hasExistingCredential ? "Leave blank to keep saved value" : "username"}
              className="h-8 text-xs font-mono bg-background"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Password</Label>
            <Input
              type="password"
              value={basicPassword}
              onChange={(event) => onFieldChange("basicPassword", event.target.value)}
              placeholder={hasExistingCredential ? "Leave blank to keep saved value" : "password"}
              className="h-8 text-xs font-mono bg-background"
            />
          </div>
        </div>
      ) : null}

      {authType !== "none" && !hasExistingCredential && !credentialsFilled && !sourceInfoLoading ? (
        <div className="flex items-start gap-1.5 rounded-md border border-terminal-amber/30 bg-terminal-amber/5 px-2.5 py-2">
          <AlertTriangle className="h-3.5 w-3.5 text-terminal-amber shrink-0 mt-0.5" />
          <p className="text-[11px] text-terminal-amber/90">
            This source requires credentials to connect. You can still add it and configure credentials later.
          </p>
        </div>
      ) : null}
    </div>
  );
}

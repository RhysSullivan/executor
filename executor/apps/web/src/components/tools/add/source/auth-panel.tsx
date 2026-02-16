import { KeyRound, LockKeyhole, UserRound } from "lucide-react";
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
  sourceOAuthStatus: "idle" | "checking" | "oauth" | "none" | "error";
  sourceOAuthDetail: string;
  sourceOAuthAuthorizationServers: string[];
  sourceOAuthConnected: boolean;
  authType: Exclude<SourceAuthType, "mixed">;
  scopeType: "organization" | "workspace";
  authScope: CredentialScope;
  apiKeyHeader: string;
  tokenValue: string;
  apiKeyValue: string;
  basicUsername: string;
  basicPassword: string;
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
  onSourceOAuthConnect,
  sourceOAuthBusy = false,
}: {
  model: SourceAuthPanelModel;
  onAuthTypeChange: (value: Exclude<SourceAuthType, "mixed">) => void;
  onScopeChange: (value: SharingScope) => void;
  onFieldChange: (field: SourceAuthPanelEditableField, value: string) => void;
  onSourceOAuthConnect?: () => void;
  sourceOAuthBusy?: boolean;
}) {
  const {
    sourceType,
    specStatus,
    inferredSpecAuth,
    specError,
    sourceOAuthStatus,
    sourceOAuthDetail,
    sourceOAuthAuthorizationServers,
    sourceOAuthConnected,
    authType,
    apiKeyHeader,
    tokenValue,
    apiKeyValue,
    basicUsername,
    basicPassword,
    hasExistingCredential,
  } = model;
  const sharingScope = sharingScopeFromModel(model);

  if (sourceType !== "openapi" && sourceType !== "graphql" && sourceType !== "mcp") {
    return null;
  }

  const badge = inferredAuthBadge(inferredSpecAuth);
  const usesSourceOAuthFlow = sourceType === "mcp" || sourceType === "openapi";
  const bearerOAuthConnected = usesSourceOAuthFlow && authType === "bearer" && sourceOAuthConnected;
  const sourceOAuthLoading = usesSourceOAuthFlow && sourceOAuthStatus === "checking";
  const sourceOAuthDetected = usesSourceOAuthFlow && sourceOAuthStatus === "oauth";
  const useSourceOAuthFlow = sourceOAuthLoading || sourceOAuthDetected;
  return (
    <div className="space-y-3">

      {sourceType === "openapi" ? (
        <div className="flex items-center gap-2 flex-wrap">
          {specStatus !== "ready" && specStatus !== "detecting" ? (
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              {specStatus === "error" ? "Schema error" : "Awaiting URL"}
            </Badge>
          ) : null}
          {badge ? (
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              {badge}
            </Badge>
          ) : null}
          {specError ? <span className="text-[10px] text-terminal-amber">{specError}</span> : null}
        </div>
      ) : null}

      {usesSourceOAuthFlow ? (
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
            {sourceOAuthStatus === "idle"
              ? "Awaiting URL"
              : sourceOAuthStatus === "checking"
                ? "Checking OAuth"
                : sourceOAuthStatus === "oauth"
                  ? "OAuth detected"
                  : sourceOAuthStatus === "error"
                    ? "OAuth unknown"
                    : "No OAuth metadata"}
          </Badge>
          {sourceOAuthAuthorizationServers.length > 0 ? (
            <span className="text-[10px] text-muted-foreground">
              {sourceOAuthAuthorizationServers[0]}
            </span>
          ) : null}
          {sourceOAuthStatus === "error" && sourceOAuthDetail ? (
            <span className="text-[10px] text-terminal-amber">{sourceOAuthDetail}</span>
          ) : null}
        </div>
      ) : null}

      <div className={`grid ${useSourceOAuthFlow ? "grid-cols-1" : "grid-cols-2"} gap-3`}>
        {!useSourceOAuthFlow ? (
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

      {usesSourceOAuthFlow && useSourceOAuthFlow && onSourceOAuthConnect ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">OAuth</Label>
            {bearerOAuthConnected ? (
              <Badge variant="outline" className="text-[10px] uppercase tracking-wider text-terminal-green">
                Connected
              </Badge>
            ) : null}
          </div>
          {sourceOAuthLoading ? (
            <Skeleton className="h-8 w-full" />
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={sourceOAuthBusy}
              onClick={onSourceOAuthConnect}
            >
              {sourceOAuthBusy ? "Connecting..." : bearerOAuthConnected ? "Reconnect OAuth" : "Connect OAuth in popup"}
            </Button>
          )}
          {bearerOAuthConnected ? (
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

      {authType === "bearer" && !usesSourceOAuthFlow ? (
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

      {authType === "apiKey" && !useSourceOAuthFlow ? (
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

      {authType === "basic" && !useSourceOAuthFlow ? (
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
    </div>
  );
}

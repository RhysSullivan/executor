import type { SourceAuthType } from "@/lib/types";

type BuildSecretJsonParams = {
  selectedAuthType: SourceAuthType;
  linkExisting: boolean;
  editing: boolean;
  basicUsername: string;
  basicPassword: string;
  apiKeyValue: string;
  tokenValue: string;
};

export function buildSecretJson({
  selectedAuthType,
  linkExisting,
  editing,
  basicUsername,
  basicPassword,
  apiKeyValue,
  tokenValue,
}: BuildSecretJsonParams): { secretJson?: Record<string, unknown>; error?: string } {
  const secretJson: Record<string, unknown> = {};
  if (!linkExisting) {
    if (selectedAuthType === "basic") {
      const hasUsername = basicUsername.trim().length > 0;
      const hasPassword = basicPassword.trim().length > 0;
      if (hasUsername || hasPassword) {
        if (!hasUsername || !hasPassword) {
          return { error: "Username and password are required for basic auth" };
        }
        secretJson.username = basicUsername;
        secretJson.password = basicPassword;
      }
    } else if (selectedAuthType === "apiKey") {
      if (apiKeyValue.trim()) {
        secretJson.value = apiKeyValue.trim();
      }
    } else if (selectedAuthType === "bearer") {
      if (tokenValue.trim()) {
        secretJson.token = tokenValue.trim();
      }
    }
  }
  if (Object.keys(secretJson).length === 0 && !editing && !linkExisting) {
    if (selectedAuthType === "basic") {
      return { error: "Username and password are required" };
    }
    if (selectedAuthType === "apiKey") {
      return { error: "API key value is required" };
    }
    return { error: "Token is required" };
  }

  return { secretJson };
}

export function connectionSuccessCopy(editing: boolean, linkExisting: boolean): string {
  return editing ? "Connection updated" : linkExisting ? "Credentials linked" : "Connection saved";
}

export function connectionSubmitCopy(editing: boolean, saving: boolean, connectionMode: "new" | "existing"): string {
  if (saving) {
    return "Saving...";
  }
  if (editing) {
    return "Update Connection";
  }
  return connectionMode === "existing" ? "Link Credentials" : "Save Connection";
}

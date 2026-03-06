import type { ToolInvocationContext, ToolPath } from "@executor-v3/codemode-core";

export type SourceKey = string & { readonly __sourceKey: unique symbol };

export type SourceAuthScheme =
  | { kind: "none" }
  | { kind: "apiKey"; in: "header" | "query"; name: string }
  | { kind: "bearer" }
  | { kind: "basic" }
  | { kind: "oauth2" }
  | { kind: "dynamic" };

export type SourceDefinition =
  | {
      sourceKey: SourceKey;
      displayName: string;
      kind: "openapi";
      enabled: boolean;
      auth: SourceAuthScheme;
      connection: {
        specUrl?: string;
        baseUrl: string;
      };
    }
  | {
      sourceKey: SourceKey;
      displayName: string;
      kind: "mcp";
      enabled: boolean;
      auth: SourceAuthScheme;
      connection: {
        endpoint: string;
        transport?: "auto" | "streamable-http" | "sse";
      };
    }
  | {
      sourceKey: SourceKey;
      displayName: string;
      kind: "snippet";
      enabled: boolean;
      auth: SourceAuthScheme;
      connection: {
        snippetId: string;
        entrypoint: string;
      };
    };

export type ToolArtifact = {
  path: ToolPath;
  sourceKey: SourceKey;
  title?: string;
  description?: string;
  inputSchemaJson?: string;
  outputSchemaJson?: string;
  search: {
    namespace: string;
    keywords: readonly string[];
  };
  invocation:
    | {
        provider: "openapi";
        operationId: string;
        method: "get" | "post" | "put" | "patch" | "delete";
        pathTemplate: string;
      }
    | {
        provider: "mcp";
        toolName: string;
      }
    | {
        provider: "snippet";
        exportName: string;
      };
};

export type SecretRef = {
  providerId: string;
  handle: string;
};

export type CredentialBinding = {
  sourceKey: SourceKey;
  authScheme: SourceAuthScheme;
  materials: Record<string, SecretRef>;
};

export type ResolvedAuthMaterial =
  | { kind: "none" }
  | { kind: "headers"; headers: Record<string, string> }
  | { kind: "query"; queryParams: Record<string, string> }
  | { kind: "composite"; values: Record<string, string> };

export type SourceCallContext = {
  auth: ResolvedAuthMaterial;
};

export interface SourceLoader {
  loadSource(input: {
    source: SourceDefinition;
  }): Promise<readonly ToolArtifact[]>;
}

export interface ToolArtifactStore {
  putArtifacts(input: {
    sourceKey: SourceKey;
    artifacts: readonly ToolArtifact[];
  }): Promise<void>;
  getByPath(input: {
    path: ToolPath;
  }): Promise<ToolArtifact | null>;
  list(): Promise<readonly ToolArtifact[]>;
}

export interface SourceStore {
  put(input: {
    source: SourceDefinition;
  }): Promise<void>;
  getByKey(input: {
    sourceKey: SourceKey;
  }): Promise<SourceDefinition | null>;
}

export interface CredentialBindingStore {
  put(input: {
    binding: CredentialBinding;
  }): Promise<void>;
  getBySourceKey(input: {
    sourceKey: SourceKey;
  }): Promise<CredentialBinding | null>;
}

export interface SecretMaterialProvider {
  providerId: string;
  get(input: {
    handle: string;
  }): Promise<string>;
}

export interface SecretMaterialRegistry {
  get(input: {
    ref: SecretRef;
  }): Promise<string>;
}

export interface SourceRuntimeResolver {
  resolveForCall(input: {
    source: SourceDefinition;
    artifact: ToolArtifact;
    context?: ToolInvocationContext;
  }): Promise<SourceCallContext>;
}

export interface ProviderInvoker {
  invoke(input: {
    source: SourceDefinition;
    artifact: ToolArtifact;
    args: unknown;
    runtime: SourceCallContext;
    context?: ToolInvocationContext;
  }): Promise<unknown>;
}

export interface ToolCallOrchestrator {
  invoke(input: {
    path: ToolPath;
    args: unknown;
    context?: ToolInvocationContext;
  }): Promise<unknown>;
}

export const asSourceKey = (value: string): SourceKey => value as SourceKey;

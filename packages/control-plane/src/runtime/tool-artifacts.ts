import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import {
  createSdkMcpConnector,
  discoverMcpToolsFromConnector,
  type McpToolManifestEntry,
} from "@executor-v3/codemode-mcp";
import { extractOpenApiManifest } from "@executor-v3/codemode-openapi";
import type { SqlControlPlaneRows } from "#persistence";
import {
  type SecretRef,
  type Source,
  type StoredToolArtifactParameterRecord,
  type StoredToolArtifactRecord,
  type StoredToolArtifactRefHintKeyRecord,
  type StoredToolArtifactRequestBodyContentTypeRecord,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  extractGraphqlManifest,
  GRAPHQL_INTROSPECTION_QUERY,
} from "./graphql-tools";
import type {
  ResolveSecretMaterial as ResolveSourceSecretMaterial,
  SecretMaterialResolveContext,
} from "./secret-material-providers";

export type ResolvedSourceAuthMaterial = {
  headers: Readonly<Record<string, string>>;
};

const trim = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
};

const joinToolPath = (namespace: string | null, toolId: string): string => {
  const normalizedNamespace = trim(namespace ?? undefined);
  return normalizedNamespace ? `${normalizedNamespace}.${toolId}` : toolId;
};

const normalizeSearchText = (...parts: ReadonlyArray<string | null | undefined>): string =>
  parts
    .flatMap((part) => (part ? [part.trim()] : []))
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

const catalogNamespaceFromPath = (path: string): string => {
  const [first, second] = path.split(".");
  return second ? `${first}.${second}` : first;
};

type IndexedToolArtifactRecord = {
  artifact: StoredToolArtifactRecord;
  parameters?: readonly StoredToolArtifactParameterRecord[];
  requestBodyContentTypes?: readonly StoredToolArtifactRequestBodyContentTypeRecord[];
  refHintKeys?: readonly StoredToolArtifactRefHintKeyRecord[];
};

const toMcpToolArtifactRecord = (input: {
  workspaceId: Source["workspaceId"];
  source: Source;
  entry: {
    toolId: string;
    toolName: string;
    description: string | null;
    inputSchemaJson?: string;
    outputSchemaJson?: string;
  };
  now: number;
}): IndexedToolArtifactRecord => {
  const sourceNamespace = input.source.namespace ?? namespaceFromSourceName(input.source.name);
  const path = joinToolPath(sourceNamespace, input.entry.toolId);
  const searchNamespace = catalogNamespaceFromPath(path);

  return {
    artifact: {
      workspaceId: input.workspaceId,
      path,
      toolId: input.entry.toolId,
      sourceId: input.source.id,
      title: input.entry.toolName,
      description: input.entry.description ?? null,
      searchNamespace,
      searchText: normalizeSearchText(
        path,
        searchNamespace,
        input.entry.toolName,
        input.entry.description ?? undefined,
      ),
      inputSchemaJson: input.entry.inputSchemaJson ?? null,
      outputSchemaJson: input.entry.outputSchemaJson ?? null,
      providerKind: "mcp",
      mcpToolName: input.entry.toolName,
      openApiMethod: null,
      openApiPathTemplate: null,
      openApiOperationHash: null,
      openApiRawToolId: null,
      openApiOperationId: null,
      openApiTagsJson: null,
      openApiRequestBodyRequired: null,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
};


const shouldIndexSource = (source: Source): boolean =>
  source.enabled
  && source.status === "connected"
  && (source.kind === "mcp" || source.kind === "openapi" || source.kind === "graphql");

export const namespaceFromSourceName = (name: string): string => {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");

  return normalized.length > 0 ? normalized : "source";
};

export const resolveSourceAuthMaterial = (input: {
  source: Source;
  resolveSecretMaterial: ResolveSourceSecretMaterial;
  context?: SecretMaterialResolveContext;
}): Effect.Effect<ResolvedSourceAuthMaterial, Error, never> =>
  Effect.gen(function* () {
    if (input.source.auth.kind === "none") {
      return { headers: {} } satisfies ResolvedSourceAuthMaterial;
    }

    const tokenRef =
      input.source.auth.kind === "bearer"
        ? input.source.auth.token
        : input.source.auth.accessToken;

    const token = yield* input.resolveSecretMaterial({
      ref: tokenRef,
      context: input.context,
    });

    return {
      headers: {
        [input.source.auth.headerName]: `${input.source.auth.prefix}${token}`,
      },
    } satisfies ResolvedSourceAuthMaterial;
  });

const fetchOpenApiDocumentWithHeaders = (input: {
  url: string;
  headers?: Readonly<Record<string, string>>;
}): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
    );
    const request = HttpClientRequest.get(input.url).pipe(
      HttpClientRequest.setHeaders(input.headers ?? {}),
    );
    const response = yield* client.execute(request).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );

    return yield* response.text.pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
  );

const fetchGraphqlIntrospectionDocumentWithHeaders = (input: {
  url: string;
  headers?: Readonly<Record<string, string>>;
}): Effect.Effect<string, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(input.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.headers ?? {}),
        },
        body: JSON.stringify({
          query: GRAPHQL_INTROSPECTION_QUERY,
          operationName: "IntrospectionQuery",
        }),
      });
      const text = await response.text();

      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch (cause) {
        throw new Error(
          `GraphQL introspection endpoint did not return JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }

      if (!response.ok) {
        throw new Error(
          `GraphQL introspection failed with status ${response.status}`,
        );
      }

      return JSON.stringify(parsed, null, 2);
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  });

const indexMcpSourceToolArtifacts = (input: {
  rows: SqlControlPlaneRows;
  source: Source;
  manifestEntries: readonly McpToolManifestEntry[];
}): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const now = Date.now();
    yield* input.rows.toolArtifacts.replaceForSource({
      workspaceId: input.source.workspaceId,
      sourceId: input.source.id,
      artifacts: input.manifestEntries.map((entry) =>
        toMcpToolArtifactRecord({
          workspaceId: input.source.workspaceId,
          source: input.source,
          entry,
          now,
        })
      ),
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
  });

const discoverAndIndexMcpSourceToolArtifacts = (input: {
  rows: SqlControlPlaneRows;
  source: Source;
  auth: ResolvedSourceAuthMaterial;
}): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const connector = yield* Effect.try({
      try: () =>
        createSdkMcpConnector({
          endpoint: input.source.endpoint,
          transport: input.source.transport ?? undefined,
          queryParams: input.source.queryParams ?? undefined,
          headers: {
            ...(input.source.headers ?? {}),
            ...input.auth.headers,
          },
        }),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    });

    const discovered = yield* discoverMcpToolsFromConnector({
      connect: connector,
      namespace: input.source.namespace ?? namespaceFromSourceName(input.source.name),
      sourceKey: input.source.id,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new Error(
            `Failed discovering MCP tools for ${input.source.id}: ${cause.message}`,
          ),
      ),
    );

    return yield* indexMcpSourceToolArtifacts({
      rows: input.rows,
      source: input.source,
      manifestEntries: discovered.manifest.tools,
    });
  });

const indexOpenApiSourceToolArtifacts = (input: {
  rows: SqlControlPlaneRows;
  source: Source;
  auth: ResolvedSourceAuthMaterial;
}): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    if (!input.source.specUrl) {
      return yield* Effect.fail(
        new Error(`Missing OpenAPI specUrl for source ${input.source.id}`),
      );
    }

    const openApiDocument = yield* fetchOpenApiDocumentWithHeaders({
      url: input.source.specUrl,
      headers: {
        ...(input.source.defaultHeaders ?? {}),
        ...input.auth.headers,
      },
    }).pipe(
      Effect.mapError((cause) =>
        new Error(
          `Failed fetching OpenAPI spec for ${input.source.id}: ${cause.message}`,
        ),
      ),
    );

    const manifest = yield* extractOpenApiManifest(
      input.source.name,
      openApiDocument,
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error
          ? cause
          : new Error(String(cause)),
      ),
    );

    const now = Date.now();
    const updatedSource = yield* input.rows.sources.update(
      input.source.workspaceId,
      input.source.id,
      {
        sourceHash: manifest.sourceHash,
        sourceDocumentText: openApiDocument,
        updatedAt: now,
      },
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );

    if (Option.isNone(updatedSource)) {
      return yield* Effect.fail(
        new Error(`Source disappeared while storing OpenAPI document for ${input.source.id}`),
      );
    }

    yield* input.rows.toolArtifacts.removeByWorkspaceAndSourceId(
      input.source.workspaceId,
      input.source.id,
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
  });

const indexGraphqlSourceToolArtifacts = (input: {
  rows: SqlControlPlaneRows;
  source: Source;
  auth: ResolvedSourceAuthMaterial;
}): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const graphqlDocument = yield* fetchGraphqlIntrospectionDocumentWithHeaders({
      url: input.source.endpoint,
      headers: {
        ...(input.source.defaultHeaders ?? {}),
        ...input.auth.headers,
      },
    }).pipe(
      Effect.mapError((cause) =>
        new Error(
          `Failed fetching GraphQL introspection for ${input.source.id}: ${cause.message}`,
        ),
      ),
    );

    const manifest = yield* extractGraphqlManifest(
      input.source.name,
      graphqlDocument,
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );

    const now = Date.now();
    const updatedSource = yield* input.rows.sources.update(
      input.source.workspaceId,
      input.source.id,
      {
        sourceHash: manifest.sourceHash,
        sourceDocumentText: graphqlDocument,
        updatedAt: now,
      },
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );

    if (Option.isNone(updatedSource)) {
      return yield* Effect.fail(
        new Error(`Source disappeared while storing GraphQL document for ${input.source.id}`),
      );
    }

    yield* input.rows.toolArtifacts.removeByWorkspaceAndSourceId(
      input.source.workspaceId,
      input.source.id,
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      ),
    );
  });

export const syncSourceToolArtifacts = (input: {
  rows: SqlControlPlaneRows;
  source: Source;
  resolveSecretMaterial: ResolveSourceSecretMaterial;
}): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    if (!shouldIndexSource(input.source)) {
      yield* input.rows.toolArtifacts.removeByWorkspaceAndSourceId(
        input.source.workspaceId,
        input.source.id,
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      );
      return;
    }

    const auth = yield* resolveSourceAuthMaterial({
      source: input.source,
      resolveSecretMaterial: input.resolveSecretMaterial,
    });

    if (input.source.kind === "mcp") {
      return yield* discoverAndIndexMcpSourceToolArtifacts({
        rows: input.rows,
        source: input.source,
        auth,
      });
    }

    if (input.source.kind === "openapi") {
      return yield* indexOpenApiSourceToolArtifacts({
        rows: input.rows,
        source: input.source,
        auth,
      });
    }

    if (input.source.kind === "graphql") {
      return yield* indexGraphqlSourceToolArtifacts({
        rows: input.rows,
        source: input.source,
        auth,
      });
    }

    return;
  });

export const storedToolIdFromArtifact = (artifact: StoredToolArtifactRecord): string =>
  artifact.toolId;

export const persistMcpToolArtifactsFromManifest = (input: {
  rows: SqlControlPlaneRows;
  source: Source;
  manifestEntries: readonly McpToolManifestEntry[];
}): Effect.Effect<void, Error, never> =>
  indexMcpSourceToolArtifacts(input);

import { createHash } from "node:crypto";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FileSystem } from "@effect/platform";
import {
  createToolCatalogFromTools,
  makeToolInvokerFromTools,
  type ExecutableTool,
  type StandardSchema,
  type ToolDefinition,
  type ToolInput,
  type ToolMap,
  type ToolMetadata,
  type ToolPath,
} from "@executor/codemode-core";
import * as Effect from "effect/Effect";
import * as ts from "typescript";

import type { LocalToolRuntime } from "@executor/platform-sdk/runtime";
import type { ResolvedLocalWorkspaceContext } from "./config";
import {
  LocalFileSystemError,
  LocalToolDefinitionError,
  LocalToolImportError,
  LocalToolPathConflictError,
  LocalToolTranspileError,
  unknownLocalErrorDetails,
} from "./errors";

const SUPPORTED_LOCAL_TOOL_EXTENSIONS = new Set([".ts", ".js", ".mjs"]);
const LOCAL_TOOLS_DIRECTORY = "tools";
const LOCAL_TOOLS_ARTIFACT_DIRECTORY = "local-tools";
const LOCAL_TOOLS_SOURCE_KEY_PREFIX = "local.tool";
const LOCAL_TOOL_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

type Awaitable<T> = T | Promise<T>;

type ParsedStandardSchema<TSchema extends StandardSchema<any, any>> =
  TSchema extends StandardSchema<any, infer Parsed> ? Parsed : never;

export type LocalTool<
  TInputSchema extends StandardSchema<any, any> = StandardSchema<any, any>,
  TOutputSchema extends StandardSchema<any, any> | undefined =
    | StandardSchema<any, any>
    | undefined,
> = {
  description?: string;
  inputSchema: TInputSchema;
  outputSchema?: TOutputSchema;
  parameters?: TInputSchema;
  execute: (
    args: ParsedStandardSchema<TInputSchema>,
  ) => Awaitable<
    TOutputSchema extends StandardSchema<any, any>
      ? ParsedStandardSchema<TOutputSchema>
      : unknown
  >;
};

export type LocalToolWithMetadata<
  TInputSchema extends StandardSchema<any, any> = StandardSchema<any, any>,
  TOutputSchema extends StandardSchema<any, any> | undefined =
    | StandardSchema<any, any>
    | undefined,
> = {
  tool: LocalTool<TInputSchema, TOutputSchema>;
  metadata?: Omit<ToolMetadata, "sourceKey">;
};

export const defineLocalTool = <
  TInputSchema extends StandardSchema<any, any>,
  TOutputSchema extends StandardSchema<any, any> | undefined = undefined,
>(
  input:
    | LocalTool<TInputSchema, TOutputSchema>
    | LocalToolWithMetadata<TInputSchema, TOutputSchema>,
): typeof input => input;

const emptyLocalToolRuntime = (): LocalToolRuntime => {
  const tools: ToolMap = {};
  return {
    tools,
    catalog: createToolCatalogFromTools({ tools }),
    toolInvoker: makeToolInvokerFromTools({ tools }),
    toolPaths: new Set(),
  };
};

const mapFileSystemError = (path: string, action: string) => (cause: unknown) =>
  new LocalFileSystemError({
    message: `Failed to ${action} ${path}: ${unknownLocalErrorDetails(cause)}`,
    action,
    path,
    details: unknownLocalErrorDetails(cause),
  });

const localToolsDirectory = (context: ResolvedLocalWorkspaceContext): string =>
  join(context.configDirectory, LOCAL_TOOLS_DIRECTORY);

const localToolsArtifactDirectory = (
  context: ResolvedLocalWorkspaceContext,
): string => join(context.artifactsDirectory, LOCAL_TOOLS_ARTIFACT_DIRECTORY);

const isSupportedLocalToolFile = (path: string): boolean =>
  SUPPORTED_LOCAL_TOOL_EXTENSIONS.has(extname(path));

const isIgnoredToolSegment = (segment: string): boolean =>
  segment.startsWith(".") || segment.startsWith("_");

const toArtifactRelativePath = (relativePath: string): string => {
  const extension = extname(relativePath);
  return `${relativePath.slice(0, -extension.length)}.js`;
};

const toToolPath = (
  relativePath: string,
): Effect.Effect<ToolPath, LocalToolDefinitionError> =>
  Effect.gen(function* () {
    const withoutExtension = relativePath.slice(
      0,
      -extname(relativePath).length,
    );
    const rawSegments = withoutExtension.split(sep).filter(Boolean);
    const segments =
      rawSegments.at(-1) === "index" ? rawSegments.slice(0, -1) : rawSegments;

    if (segments.length === 0) {
      return yield* new LocalToolDefinitionError({
          message: `Invalid local tool path ${relativePath}: root index files are not supported`,
          path: relativePath,
          details:
            "Root index files are not supported. Use a named file such as hello.ts or a nested index.ts.",
        });
    }

    for (const segment of segments) {
      if (!LOCAL_TOOL_SEGMENT_PATTERN.test(segment)) {
        return yield* new LocalToolDefinitionError({
            message: `Invalid local tool path ${relativePath}: segment ${segment} contains unsupported characters`,
            path: relativePath,
            details: `Tool path segments may only contain letters, numbers, underscores, and hyphens. Invalid segment: ${segment}`,
          });
      }
    }

    return segments.join(".") as ToolPath;
  });

const readDirectoryEntries = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs
      .readDirectory(path)
      .pipe(
        Effect.mapError(mapFileSystemError(path, "read local tools directory")),
      );
    return entries.sort((left, right) => left.localeCompare(right));
  });

const collectLocalToolSourceFiles = (
  root: string,
): Effect.Effect<string[], LocalFileSystemError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(root)
      .pipe(
        Effect.mapError(
          mapFileSystemError(root, "check local tools directory"),
        ),
      );
    if (!exists) {
      return [];
    }

    const walk = (
      directory: string,
    ): Effect.Effect<string[], LocalFileSystemError, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const entries = yield* readDirectoryEntries(directory);
        const files: string[] = [];

        for (const entry of entries) {
          const fullPath = join(directory, entry);
          const info = yield* fs
            .stat(fullPath)
            .pipe(
              Effect.mapError(
                mapFileSystemError(fullPath, "stat local tool path"),
              ),
            );

          if (info.type === "Directory") {
            files.push(...(yield* walk(fullPath)));
            continue;
          }

          if (info.type === "File" && isSupportedLocalToolFile(fullPath)) {
            files.push(fullPath);
          }
        }

        return files;
      });

    return yield* walk(root);
  });

const toolCandidateFiles = (root: string, files: readonly string[]): string[] =>
  files.filter((path) =>
    relative(root, path)
      .split(sep)
      .every((segment) => !isIgnoredToolSegment(segment)),
  );

const resolveCompilerDiagnostics = (
  sourcePath: string,
  diagnostics: readonly ts.Diagnostic[] | undefined,
): LocalToolTranspileError | null => {
  const issues = (diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        "\n",
      );
      if (!diagnostic.file || diagnostic.start === undefined) {
        return message;
      }
      const position = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start,
      );
      return `${position.line + 1}:${position.character + 1} ${message}`;
    });

  if (issues.length === 0) {
    return null;
  }

  return new LocalToolTranspileError({
    message: `Failed to transpile local tool ${sourcePath}`,
    path: sourcePath,
    details: issues.join("\n"),
  });
};

const normalizeRelativeImportSpecifier = (specifier: string): string => {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return specifier;
  }

  const match = specifier.match(/^(.*?)(\?.*|#.*)?$/);
  const pathname = match?.[1] ?? specifier;
  const suffix = match?.[2] ?? "";
  const extension = extname(pathname);

  if (extension === ".js") {
    return specifier;
  }

  if ([".ts", ".mjs"].includes(extension)) {
    return `${pathname.slice(0, -extension.length)}.js${suffix}`;
  }

  if (extension.length > 0) {
    return specifier;
  }

  return `${pathname}.js${suffix}`;
};

const rewriteRelativeImportSpecifiers = (code: string): string =>
  code
    .replace(
      /(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g,
      (_match, prefix: string, specifier: string, suffix: string) =>
        `${prefix}${normalizeRelativeImportSpecifier(specifier)}${suffix}`,
    )
    .replace(
      /(import\s+["'])(\.{1,2}\/[^"']+)(["'])/g,
      (_match, prefix: string, specifier: string, suffix: string) =>
        `${prefix}${normalizeRelativeImportSpecifier(specifier)}${suffix}`,
    )
    .replace(
      /(import\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g,
      (_match, prefix: string, specifier: string, suffix: string) =>
        `${prefix}${normalizeRelativeImportSpecifier(specifier)}${suffix}`,
    );

const transpileSourceFile = (input: {
  sourcePath: string;
  content: string;
}): Effect.Effect<string, LocalToolTranspileError> =>
  Effect.gen(function* () {
    if (extname(input.sourcePath) !== ".ts") {
      return rewriteRelativeImportSpecifiers(input.content);
    }

    const transpiled = ts.transpileModule(input.content, {
      fileName: input.sourcePath,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2022,
        sourceMap: false,
        inlineSourceMap: false,
        inlineSources: false,
      },
      reportDiagnostics: true,
    });

    const diagnosticError = resolveCompilerDiagnostics(
      input.sourcePath,
      transpiled.diagnostics,
    );
    if (diagnosticError) {
      return yield* diagnosticError;
    }

    return rewriteRelativeImportSpecifiers(transpiled.outputText);
  });

const resolveExecutorNodeModulesDirectory = (): Effect.Effect<
  string | null,
  LocalFileSystemError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let current = dirname(fileURLToPath(import.meta.url));

    while (true) {
      const candidate = join(current, "node_modules");
      const exists = yield* fs
        .exists(candidate)
        .pipe(
          Effect.mapError(
            mapFileSystemError(
              candidate,
              "check executor node_modules directory",
            ),
          ),
        );
      if (exists) {
        return candidate;
      }

      const parent = dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  });

const ensureArtifactNodeModulesLink = (artifactRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const linkPath = join(artifactRoot, "node_modules");
    const executorNodeModulesDirectory = yield* resolveExecutorNodeModulesDirectory();
    const exists = yield* fs
      .exists(linkPath)
      .pipe(
        Effect.mapError(
          mapFileSystemError(linkPath, "check local tool node_modules link"),
        ),
      );
    if (exists) {
      return;
    }

    if (executorNodeModulesDirectory === null) {
      return;
    }

    yield* fs
      .symlink(executorNodeModulesDirectory, linkPath)
      .pipe(
        Effect.mapError(
          mapFileSystemError(linkPath, "create local tool node_modules link"),
        ),
      );
  });

const buildLocalToolArtifacts = (input: {
  context: ResolvedLocalWorkspaceContext;
  sourceDirectory: string;
  sourceFiles: readonly string[];
}): Effect.Effect<
  Map<string, string>,
  LocalFileSystemError | LocalToolTranspileError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sources = yield* Effect.forEach(input.sourceFiles, (sourcePath) =>
      Effect.gen(function* () {
        const content = yield* fs
          .readFileString(sourcePath, "utf8")
          .pipe(
            Effect.mapError(
              mapFileSystemError(sourcePath, "read local tool source"),
            ),
          );
        const relativePath = relative(input.sourceDirectory, sourcePath);
        const contentHash = createHash("sha256")
          .update(relativePath)
          .update("\0")
          .update(content)
          .digest("hex")
          .slice(0, 12);
        return {
          sourcePath,
          relativePath,
          content,
          contentHash,
        };
      }),
    );

    const buildHash = createHash("sha256")
      .update(
        JSON.stringify(
          sources.map((source) => [source.relativePath, source.contentHash]),
        ),
      )
      .digest("hex")
      .slice(0, 16);
    const artifactRoot = join(
      localToolsArtifactDirectory(input.context),
      buildHash,
    );

    yield* fs
      .makeDirectory(artifactRoot, { recursive: true })
      .pipe(
        Effect.mapError(
          mapFileSystemError(
            artifactRoot,
            "create local tool artifact directory",
          ),
        ),
      );
    yield* ensureArtifactNodeModulesLink(artifactRoot);

    const output = new Map<string, string>();

    for (const source of sources) {
      const artifactRelativePath = toArtifactRelativePath(source.relativePath);
      const artifactPath = join(artifactRoot, artifactRelativePath);
      const artifactDirectory = dirname(artifactPath);
      const transpiled = yield* transpileSourceFile({
        sourcePath: source.sourcePath,
        content: source.content,
      });

      yield* fs
        .makeDirectory(artifactDirectory, { recursive: true })
        .pipe(
          Effect.mapError(
            mapFileSystemError(
              artifactDirectory,
              "create local tool artifact parent directory",
            ),
          ),
        );
      yield* fs
        .writeFileString(artifactPath, transpiled)
        .pipe(
          Effect.mapError(
            mapFileSystemError(artifactPath, "write local tool artifact"),
          ),
        );

      output.set(source.sourcePath, artifactPath);
    }

    return output;
  });

const isExecutableTool = (value: unknown): value is ExecutableTool =>
  typeof value === "object" &&
  value !== null &&
  "inputSchema" in value &&
  typeof (value as { execute?: unknown }).execute === "function";

const isToolDefinition = (value: unknown): value is ToolDefinition =>
  typeof value === "object" &&
  value !== null &&
  "tool" in value &&
  isExecutableTool((value as { tool?: unknown }).tool);

const normalizeToolExport = (input: {
  toolPath: ToolPath;
  sourcePath: string;
  exported: unknown;
}): Effect.Effect<ToolInput, LocalToolDefinitionError> => {
  const sourceKey = `${LOCAL_TOOLS_SOURCE_KEY_PREFIX}.${input.toolPath}`;

  if (isToolDefinition(input.exported)) {
    const definition = input.exported;
    return Effect.succeed({
      ...definition,
      metadata: {
        ...definition.metadata,
        sourceKey,
      },
    });
  }

  if (isExecutableTool(input.exported)) {
    const tool = input.exported;
    return Effect.succeed({
      tool,
      metadata: {
        sourceKey,
      },
    });
  }

  return Effect.fail(
    new LocalToolDefinitionError({
      message: `Invalid local tool export in ${input.sourcePath}`,
      path: input.sourcePath,
      details:
        "Local tool files must export a default value or named `tool` export containing either an executable tool or a `{ tool, metadata? }` definition.",
    }),
  );
};

const importLocalToolModule = (input: {
  sourcePath: string;
  artifactPath: string;
  toolPath: ToolPath;
}): Effect.Effect<ToolInput, LocalToolImportError | LocalToolDefinitionError> =>
  Effect.tryPromise({
    try: () => import(/* @vite-ignore */ pathToFileURL(resolve(input.artifactPath)).href),
    catch: (cause) =>
      new LocalToolImportError({
        message: `Failed to import local tool ${input.sourcePath}`,
        path: input.sourcePath,
        details: unknownLocalErrorDetails(cause),
      }),
  }).pipe(
    Effect.flatMap((mod) => {
      const hasDefault = mod.default !== undefined;
      const hasNamedTool = mod.tool !== undefined;

      if (hasDefault && hasNamedTool) {
        return Effect.fail(
          new LocalToolDefinitionError({
            message: `Invalid local tool export in ${input.sourcePath}`,
            path: input.sourcePath,
            details:
              "Export either a default tool or a named `tool` export, but not both.",
          }),
        );
      }

      if (!hasDefault && !hasNamedTool) {
        return Effect.fail(
          new LocalToolDefinitionError({
            message: `Missing local tool export in ${input.sourcePath}`,
            path: input.sourcePath,
            details: "Expected a default export or named `tool` export.",
          }),
        );
      }

      return normalizeToolExport({
        toolPath: input.toolPath,
        sourcePath: input.sourcePath,
        exported: hasDefault ? mod.default : mod.tool,
      });
    }),
  );

export const loadLocalToolRuntime = (
  context: ResolvedLocalWorkspaceContext,
): Effect.Effect<
  LocalToolRuntime,
  | LocalFileSystemError
  | LocalToolDefinitionError
  | LocalToolImportError
  | LocalToolPathConflictError
  | LocalToolTranspileError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const sourceDirectory = localToolsDirectory(context);
    const sourceFiles = yield* collectLocalToolSourceFiles(sourceDirectory);

    if (sourceFiles.length === 0) {
      return emptyLocalToolRuntime();
    }

    const artifactPaths = yield* buildLocalToolArtifacts({
      context,
      sourceDirectory,
      sourceFiles,
    });
    const candidateFiles = toolCandidateFiles(sourceDirectory, sourceFiles);
    const tools: ToolMap = {};
    const seenToolPaths = new Map<string, string>();

    for (const sourcePath of candidateFiles) {
      const relativePath = relative(sourceDirectory, sourcePath);
      const toolPath = yield* toToolPath(relativePath);
      const existing = seenToolPaths.get(toolPath);
      if (existing) {
        return yield* new LocalToolPathConflictError({
            message: `Local tool path conflict for ${toolPath}`,
            path: sourcePath,
            otherPath: existing,
            toolPath,
          });
      }

      const artifactPath = artifactPaths.get(sourcePath);
      if (!artifactPath) {
        return yield* new LocalToolImportError({
            message: `Missing compiled artifact for local tool ${sourcePath}`,
            path: sourcePath,
            details:
              "Expected a compiled local tool artifact, but none was produced.",
          });
      }

      tools[toolPath] = yield* importLocalToolModule({
        sourcePath,
        artifactPath,
        toolPath,
      });
      seenToolPaths.set(toolPath, sourcePath);
    }

    return {
      tools,
      catalog: createToolCatalogFromTools({ tools }),
      toolInvoker: makeToolInvokerFromTools({ tools }),
      toolPaths: new Set(Object.keys(tools)),
    } satisfies LocalToolRuntime;
  });

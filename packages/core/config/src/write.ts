import { Effect } from "effect";
import { FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import * as jsonc from "jsonc-parser";
import type { SourceConfig, ExecutorFileConfig } from "./schema";

const FORMATTING: jsonc.FormattingOptions = {
  tabSize: 2,
  insertSpaces: true,
  eol: "\n",
};

const DEFAULT_CONFIG = `{
  "sources": []
}
`;

/** Read the raw JSONC text from a config file, or create a default one. */
const readOrCreate = (
  fs: FileSystem.FileSystem,
  path: string,
): Effect.Effect<string, PlatformError> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(path);
    if (exists) return yield* fs.readFileString(path);
    yield* fs.writeFileString(path, DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  });

/**
 * Add a source entry to the config file. Creates the file if it doesn't exist.
 * Preserves existing comments and formatting.
 */
export const addSourceToConfig = (
  path: string,
  source: SourceConfig,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let text = yield* readOrCreate(fs, path);

    // Ensure "sources" array exists
    let tree = jsonc.parseTree(text);
    let sourcesNode = tree ? jsonc.findNodeAtLocation(tree, ["sources"]) : undefined;

    if (!sourcesNode) {
      const edits = jsonc.modify(text, ["sources"], [source], {
        formattingOptions: FORMATTING,
      });
      text = jsonc.applyEdits(text, edits);
    } else {
      // Remove existing entry with same namespace (if any) to avoid duplicates
      const ns = "namespace" in source ? source.namespace : undefined;
      if (ns && sourcesNode.children) {
        for (let i = sourcesNode.children.length - 1; i >= 0; i--) {
          const child = sourcesNode.children[i]!;
          const nsNode = jsonc.findNodeAtLocation(child, ["namespace"]);
          if (nsNode && jsonc.getNodeValue(nsNode) === ns) {
            const edits = jsonc.modify(text, ["sources", i], undefined, {
              formattingOptions: FORMATTING,
            });
            text = jsonc.applyEdits(text, edits);
          }
        }
        // Re-parse after removals
        tree = jsonc.parseTree(text);
        sourcesNode = tree ? jsonc.findNodeAtLocation(tree, ["sources"]) : undefined;
      }

      const count = sourcesNode?.children?.length ?? 0;
      const edits = jsonc.modify(text, ["sources", count], source, {
        formattingOptions: FORMATTING,
      });
      text = jsonc.applyEdits(text, edits);
    }

    yield* fs.writeFileString(path, text);
  });

/**
 * Remove a source from the config file by namespace.
 */
export const removeSourceFromConfig = (
  path: string,
  namespace: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const exists = yield* fs.exists(path);
    if (!exists) return;

    let text = yield* fs.readFileString(path);
    const tree = jsonc.parseTree(text);
    if (!tree) return;

    const sourcesNode = jsonc.findNodeAtLocation(tree, ["sources"]);
    if (!sourcesNode?.children) return;

    // Walk backwards so indices stay valid after each removal
    for (let i = sourcesNode.children.length - 1; i >= 0; i--) {
      const child = sourcesNode.children[i]!;
      const nsNode = jsonc.findNodeAtLocation(child, ["namespace"]);
      if (nsNode && jsonc.getNodeValue(nsNode) === namespace) {
        const edits = jsonc.modify(text, ["sources", i], undefined, {
          formattingOptions: FORMATTING,
        });
        text = jsonc.applyEdits(text, edits);
      }
    }

    yield* fs.writeFileString(path, text);
  });

/**
 * Write a full config object to a file.
 */
export const writeConfig = (
  path: string,
  config: ExecutorFileConfig,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* Effect.try(() => JSON.stringify(config, null, 2) + "\n").pipe(Effect.orDie);
    yield* fs.writeFileString(path, text);
  });

/**
 * Add secret metadata to the config file.
 */
export const addSecretToConfig = (
  path: string,
  secretId: string,
  metadata: { name: string; provider?: string; purpose?: string },
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let text = yield* readOrCreate(fs, path);

    const edits = jsonc.modify(text, ["secrets", secretId], metadata, {
      formattingOptions: FORMATTING,
    });
    text = jsonc.applyEdits(text, edits);

    yield* fs.writeFileString(path, text);
  });

/**
 * Remove secret metadata from the config file.
 */
export const removeSecretFromConfig = (
  path: string,
  secretId: string,
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const exists = yield* fs.exists(path);
    if (!exists) return;

    let text = yield* fs.readFileString(path);
    const edits = jsonc.modify(text, ["secrets", secretId], undefined, {
      formattingOptions: FORMATTING,
    });
    text = jsonc.applyEdits(text, edits);

    yield* fs.writeFileString(path, text);
  });

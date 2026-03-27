import { FileSystem } from "@effect/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { SimpleFS } from "./types";

const notImplemented = (method: string): never => {
  throw new Error(`FileSystem.${method} is not implemented in the SDK fs adapter`);
};

/**
 * Creates an Effect FileSystem.FileSystem Layer backed by simple async callbacks.
 * Only methods used by @executor/platform-sdk-file are implemented.
 */
export const createFileSystemLayer = (
  fs: SimpleFS,
): Layer.Layer<FileSystem.FileSystem> => {
  const tryFs = <A>(
    method: string,
    path: string,
    fn: () => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: fn,
      catch: (err) => {
        const e = err instanceof Error ? err : new Error(String(err));
        return e;
      },
    }).pipe(Effect.mapError((e) => e as any));

  // Partial implementation — only methods actually used by sdk-file
  const impl = {
    access: (path: string) => tryFs("access", path, async () => {
      const exists = await fs.exists(path);
      if (!exists) throw new Error(`ENOENT: ${path}`);
    }),
    readFile: (path: string) => tryFs("readFile", path, async () => {
      const content = await fs.readFile(path);
      return typeof content === "string"
        ? new Uint8Array(Buffer.from(content, "utf-8"))
        : new Uint8Array(content);
    }),
    readFileString: (path: string) => tryFs("readFileString", path, async () => {
      const content = await fs.readFile(path);
      return typeof content === "string"
        ? content
        : Buffer.from(content).toString("utf-8");
    }),
    writeFile: (path: string, data: Uint8Array) =>
      tryFs("writeFile", path, () => fs.writeFile(path, Buffer.from(data))),
    writeFileString: (path: string, data: string) =>
      tryFs("writeFileString", path, () => fs.writeFile(path, data)),
    exists: (path: string) =>
      Effect.tryPromise({
        try: () => fs.exists(path),
        catch: () => false,
      }),
    makeDirectory: (path: string, options?: { recursive?: boolean }) =>
      tryFs("makeDirectory", path, () => fs.mkdir(path, options)),
    remove: (path: string) =>
      tryFs("remove", path, () => fs.rm(path)),
  };

  return Layer.succeed(
    FileSystem.FileSystem,
    impl as unknown as FileSystem.FileSystem,
  );
};

export class RpcTarget {}

export class WorkerEntrypoint {}

type WorkerLoaderOptions = {
  readonly mainModule: string;
  readonly modules: Record<string, string>;
  readonly globalOutbound?: unknown;
};

type LoadedWorker = {
  readonly getEntrypoint: () => unknown;
};

const compileEntrypoint = (options: WorkerLoaderOptions): unknown => {
  const source = options.modules[options.mainModule];
  if (!source) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: test stub mirrors WorkerLoader's throwing module resolution
    throw new Error(`Missing dynamic worker module: ${options.mainModule}`);
  }

  const factorySource = source
    .replace('import { WorkerEntrypoint } from "cloudflare:workers";', "")
    .replace(
      "export default class CodeExecutor extends WorkerEntrypoint",
      "return class CodeExecutor extends WorkerEntrypoint",
    );
  const WorkerClass = new Function("WorkerEntrypoint", factorySource)(WorkerEntrypoint);
  const entrypoint = new WorkerClass();
  const evaluate = entrypoint.evaluate.bind(entrypoint);
  entrypoint.evaluate = async (...args: ReadonlyArray<unknown>) => {
    if (options.globalOutbound !== null) {
      return evaluate(...args);
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      // oxlint-disable-next-line executor/no-promise-reject, executor/no-error-constructor -- boundary: test stub installs a failing host fetch implementation
      Promise.reject(new Error("Dynamic worker outbound fetch is disabled"))) as typeof fetch;
    // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: test stub must restore patched global fetch after invoking dynamic worker code
    try {
      return await evaluate(...args);
    } finally {
      globalThis.fetch = originalFetch;
    }
  };
  return entrypoint;
};

const makeLoadedWorker = (options: WorkerLoaderOptions): LoadedWorker => {
  const entrypoint = compileEntrypoint(options);
  return {
    getEntrypoint: () => entrypoint,
  };
};

export const env: { readonly LOADER: WorkerLoader } = {
  LOADER: {
    get: (_name, makeOptions) => makeLoadedWorker(makeOptions()) as never,
  },
};

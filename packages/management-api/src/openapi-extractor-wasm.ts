import { readFile } from "node:fs/promises";

import initWasmExtractor, {
  extract_manifest_json_wasm,
} from "./openapi-extractor-wasm/openapi_extractor.js";

let initPromise: Promise<void> | undefined;

const ensureWasmReady = (): Promise<void> => {
  if (!initPromise) {
    initPromise = readFile(
      new URL("./openapi-extractor-wasm/openapi_extractor_bg.wasm", import.meta.url),
    ).then((wasmBytes) =>
      initWasmExtractor({ module_or_path: wasmBytes }).then(() => undefined)
    );
  }

  return initPromise;
};

export const extractOpenApiManifestJsonWithWasm = (
  sourceName: string,
  openApiDocumentText: string,
): Promise<string> =>
  ensureWasmReady().then(() =>
    extract_manifest_json_wasm(sourceName, openApiDocumentText)
  );

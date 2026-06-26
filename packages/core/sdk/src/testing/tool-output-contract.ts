import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

export type OutputTypeScriptContract = {
  readonly outputTypeScript?: string;
  readonly typeScriptDefinitions?: Record<string, string>;
};

export type TypeCheckOutputTypeScriptOptions = {
  readonly consumerSource?: string;
  readonly fileName?: string;
  readonly typeName?: string;
  readonly valueName?: string;
};

// TypeScript 7 (the native compiler) removed the classic `require("typescript")`
// JS API, so we type-check the synthesized snippet by invoking the native `tsgo`
// binary against a throwaway file. The binary is resolved through the
// `@typescript/native-preview` shim, which locates the right platform build.
const resolveTsgoShim = (): string => {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("@typescript/native-preview/package.json");
  return path.join(path.dirname(packageJson), "bin", "tsgo.js");
};

const ERROR_LINE = /: error TS\d+:/;

export const typeCheckOutputTypeScript = (
  contract: OutputTypeScriptContract | null | undefined,
  runtimeOutput: unknown,
  options: TypeCheckOutputTypeScriptOptions = {},
): readonly string[] => {
  if (!contract?.outputTypeScript) {
    return ["missing outputTypeScript"];
  }

  const fileName = options.fileName ?? "tool-output-contract.ts";
  const typeName = options.typeName ?? "ToolOutput";
  const valueName = options.valueName ?? "invokedOutput";
  const source = [
    ...Object.entries(contract.typeScriptDefinitions ?? {}).map(
      ([name, definition]) => `type ${name} = ${definition};`,
    ),
    `type ${typeName} = ${contract.outputTypeScript};`,
    `const ${valueName}: ${typeName} = ${JSON.stringify(runtimeOutput)};`,
    options.consumerSource ?? `${valueName};`,
  ].join("\n");

  const dir = mkdtempSync(path.join(tmpdir(), "tool-output-contract-"));
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: sync test helper that spawns the native tsgo compiler over a throwaway temp dir; the finally guarantees temp-dir cleanup, no Effect runtime in scope
  try {
    writeFileSync(path.join(dir, fileName), source);
    const result = spawnSync(
      process.execPath,
      [
        resolveTsgoShim(),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "es2022",
        "--module",
        "esnext",
        "--pretty",
        "false",
        fileName,
      ],
      { cwd: dir, encoding: "utf8" },
    );
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => ERROR_LINE.test(line));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

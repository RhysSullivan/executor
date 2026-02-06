import ts from "typescript";

const VIRTUAL_FILE = "/__openassistant__/codemode-check.ts";

const TOOL_DECLARATIONS = [
  "type CalendarUpdateInput = { title: string; startsAt: string; notes?: string };",
  "declare const tools: {",
  "  calendar: {",
  "    update(input: CalendarUpdateInput): Promise<unknown>;",
  "    list(): Promise<unknown>;",
  "  };",
  "};",
].join("\n");

export type CodeTypecheckResult =
  | { ok: true }
  | { ok: false; error: string };

export function typecheckCodeSnippet(code: string): CodeTypecheckResult {
  const source = [
    TOOL_DECLARATIONS,
    "async function __openassistant_check() {",
    code,
    "}",
  ].join("\n\n");

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  };

  const host = ts.createCompilerHost(compilerOptions, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (fileName === VIRTUAL_FILE) {
      return ts.createSourceFile(fileName, source, languageVersion, true);
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  host.readFile = (fileName) => {
    if (fileName === VIRTUAL_FILE) {
      return source;
    }
    return originalReadFile(fileName);
  };

  host.fileExists = (fileName) => {
    if (fileName === VIRTUAL_FILE) {
      return true;
    }
    return originalFileExists(fileName);
  };

  const program = ts.createProgram([VIRTUAL_FILE], compilerOptions, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => {
    if (!diagnostic.file) {
      return true;
    }
    return diagnostic.file.fileName === VIRTUAL_FILE;
  });

  if (diagnostics.length === 0) {
    return { ok: true };
  }

  const message = diagnostics
    .slice(0, 3)
    .map((diagnostic) => {
      const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      if (!diagnostic.file || diagnostic.start === undefined) {
        return text;
      }
      const lineAndCharacter = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return `${lineAndCharacter.line + 1}:${lineAndCharacter.character + 1} ${text}`;
    })
    .join(" | ");

  return { ok: false, error: message };
}

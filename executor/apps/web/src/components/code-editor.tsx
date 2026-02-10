"use client";

import { useRef, useEffect } from "react";
import Editor, { type OnMount, type BeforeMount, type Monaco } from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import { useTheme } from "next-themes";
import type { ToolDescriptor } from "@/lib/types";
import { cn } from "@/lib/utils";

// ── Generate TypeScript declarations for the tools proxy ──

interface NamespaceNode {
  children: Map<string, NamespaceNode>;
  tools: ToolDescriptor[];
}

function buildTree(tools: ToolDescriptor[]): NamespaceNode {
  const root: NamespaceNode = { children: new Map(), tools: [] };
  for (const tool of tools) {
    const parts = tool.path.split(".");
    if (parts.length === 1) {
      root.tools.push(tool);
    } else {
      // Navigate/create namespace nodes for all segments except the last (which is the method name)
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node.children.has(parts[i])) {
          node.children.set(parts[i], { children: new Map(), tools: [] });
        }
        node = node.children.get(parts[i])!;
      }
      node.tools.push(tool);
    }
  }
  return root;
}

function emitToolMethod(tool: ToolDescriptor, dtsSources: Set<string>): string {
  const funcName = tool.path.split(".").pop()!;
  const approvalNote =
    tool.approval === "required"
      ? " **Requires approval** - execution will pause until approved."
      : "";
  const desc = tool.description
    ? `${tool.description}${approvalNote}`
    : approvalNote || "Call this tool.";

  // For OpenAPI tools with operationId, use indexed access types only when
  // this source has a loaded .d.ts block.
  const hasSourceDts = Boolean(tool.source && dtsSources.has(tool.source));
  if (tool.operationId && hasSourceDts) {
    const opKey = JSON.stringify(tool.operationId);
    return `  /**
   * ${desc}
   *${tool.source ? ` @source ${tool.source}` : ""}
   */
  ${funcName}(input: ToolInput<operations[${opKey}]>): Promise<ToolOutput<operations[${opKey}]>>;`;
  }

  // Fallback for MCP, GraphQL, builtins — use argsType/returnsType strings
  const strictArgsType = tool.strictArgsType?.trim();
  const strictReturnsType = tool.strictReturnsType?.trim();
  const fallbackArgsType = tool.argsType?.trim();
  const fallbackReturnsType = tool.returnsType?.trim();
  const hasArgsType = Boolean(strictArgsType || fallbackArgsType);
  const argsType = strictArgsType || fallbackArgsType || "Record<string, unknown>";
  const returnsType = strictReturnsType || fallbackReturnsType || "unknown";
  const inputParam = !hasArgsType || argsType === "{}"
    ? `input?: ${argsType}`
    : `input: ${argsType}`;

  return `  /**
   * ${desc}
   *${tool.source ? ` @source ${tool.source}` : ""}
   */
  ${funcName}(${inputParam}): Promise<${returnsType}>;`;
}

function emitNamespaceInterface(
  name: string,
  node: NamespaceNode,
  dtsSources: Set<string>,
  out: string[],
): void {
  // First, recursively emit child namespace interfaces
  for (const [childName, childNode] of node.children) {
    emitNamespaceInterface(`${name}_${childName}`, childNode, dtsSources, out);
  }

  // Build this namespace's interface
  const members: string[] = [];

  // Add child namespace accessors
  for (const [childName, childNode] of node.children) {
    const toolCount =
      childNode.tools.length + countAllTools(childNode);
    members.push(`  /** ${toolCount} tool${toolCount !== 1 ? "s" : ""} in the \`${childName}\` namespace */
  readonly ${childName}: ToolNS_${name}_${childName};`);
  }

  // Add tool methods
  for (const tool of node.tools) {
    members.push(emitToolMethod(tool, dtsSources));
  }

  out.push(`interface ToolNS_${name} {\n${members.join("\n\n")}\n}`);
}

function countAllTools(node: NamespaceNode): number {
  let count = node.tools.length;
  for (const child of node.children.values()) {
    count += countAllTools(child);
  }
  return count;
}

/** TS helper types for OpenAPI indexed access (same as typechecker.ts) */
const OPENAPI_HELPER_TYPES = `
type _OrEmpty<T> = [T] extends [never] ? {} : T;
type _Simplify<T> = { [K in keyof T]: T[K] } & {};
type ToolInput<Op> = _Simplify<
  _OrEmpty<Op extends { parameters: { query: infer Q } } ? { [K in keyof Q]: Q[K] } : never> &
  _OrEmpty<Op extends { parameters: { path: infer P } } ? { [K in keyof P]: P[K] } : never> &
  _OrEmpty<Op extends { requestBody: { content: { "application/json": infer B } } } ? B : never>
>;
type ToolOutput<Op> =
  Op extends { responses: { 200: { content: { "application/json": infer R } } } } ? R :
  Op extends { responses: { 201: { content: { "application/json": infer R } } } } ? R :
  Op extends { responses: { 202: { content: { "application/json": infer R } } } } ? R :
  Op extends { responses: { 204: unknown } } ? void :
  Op extends { responses: { 205: unknown } } ? void :
  unknown;
`;

function generateToolsDts(tools: ToolDescriptor[], dtsSources: Set<string>): string {
  const root = buildTree(tools);

  const interfaces: string[] = [];

  // Emit all namespace interfaces recursively
  for (const [name, node] of root.children) {
    emitNamespaceInterface(name, node, dtsSources, interfaces);
  }

  // Build root ToolsProxy interface
  const rootMembers: string[] = [];

  // Root-level namespace accessors
  for (const [name] of root.children) {
    rootMembers.push(`  readonly ${name}: ToolNS_${name};`);
  }

  // Root-level tools (rare but possible)
  for (const tool of root.tools) {
    rootMembers.push(emitToolMethod(tool, dtsSources));
  }

  let dts = `
/**
 * The \`tools\` object is a proxy that lets you call registered executor tools.
 * Each call returns a Promise with the tool's result.
 * Tools marked with "approval: required" will pause execution until approved.
 */
`;

  // Note: .d.ts blocks from OpenAPI sources are fetched separately and registered
  // as a distinct Monaco extra lib (see dtsUrls effect). This keeps generateToolsDts
  // fast and avoids bundling multi-MB .d.ts content into the tool declarations string.

  dts += interfaces.join("\n\n") + "\n\n";
  dts += `interface ToolsProxy {\n${rootMembers.join("\n\n")}\n}\n\n`;
  dts += `declare const tools: ToolsProxy;\n`;

  return dts;
}

// ── Base environment declarations ──
// These provide types for the executor runtime environment
// (console, setTimeout, etc.) since we don't include the full DOM lib.

const BASE_ENVIRONMENT_DTS = `
interface Console {
  /** Log output to stdout (visible in task detail). */
  log(...args: any[]): void;
  /** Log output to stderr (visible in task detail). */
  error(...args: any[]): void;
  /** Log a warning to stderr. */
  warn(...args: any[]): void;
  info(...args: any[]): void;
  debug(...args: any[]): void;
}
declare var console: Console;

declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): number;
declare function clearTimeout(id: number): void;
declare function setInterval(callback: (...args: any[]) => void, ms?: number, ...args: any[]): number;
declare function clearInterval(id: number): void;
`;

const DIAGNOSTIC_CODES_TO_IGNORE = [
  1375, // 'await' expressions are only allowed at the top level of a file when that file is a module
  1378, // Top-level 'await' expressions are only allowed when the 'module' option is set to 'es2022'...
  2307, // Cannot find module
  80005, // 'require' call may be converted to an import
];

function setDiagnosticsOptions(monaco: Monaco, suppressSemantic: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ts = (monaco.languages as any).typescript;
  ts.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: suppressSemantic,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: DIAGNOSTIC_CODES_TO_IGNORE,
  });
}

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  tools: ToolDescriptor[];
  /** Per-source .d.ts download URLs for OpenAPI IntelliSense. Keyed by source key. */
  dtsUrls?: Record<string, string>;
  typesLoading?: boolean;
  className?: string;
  height?: string;
}

export function CodeEditor({
  value,
  onChange,
  tools,
  dtsUrls,
  typesLoading = false,
  className,
  height = "400px",
}: CodeEditorProps) {
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const envLibDisposable = useRef<{ dispose: () => void } | null>(null);
  const toolsLibDisposable = useRef<{ dispose: () => void } | null>(null);
  const dtsLibDisposables = useRef<{ dispose: () => void }[]>([]);
  const toolsLibVersion = useRef(0);
  const fetchedDtsUrls = useRef<string>("");
  const dtsSources = new Set(Object.keys(dtsUrls ?? {}));

  // Fetch and register .d.ts blobs from OpenAPI sources
  useEffect(() => {
    if (!dtsUrls || Object.keys(dtsUrls).length === 0) return;
    const m = monacoRef.current;
    if (!m) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jsDefaults = (m.languages as any).typescript.javascriptDefaults;

    // Skip if URLs haven't changed
    const urlsKey = JSON.stringify(dtsUrls);
    if (urlsKey === fetchedDtsUrls.current) return;
    fetchedDtsUrls.current = urlsKey;

    // Dispose previous .d.ts libs
    for (const d of dtsLibDisposables.current) d.dispose();
    dtsLibDisposables.current = [];

    let cancelled = false;

    // Fetch each .d.ts blob and register with Monaco
    const entries = Object.entries(dtsUrls);
    Promise.all(
      entries.map(async ([sourceKey, url]) => {
        try {
          const resp = await fetch(url);
          if (!resp.ok || cancelled) return null;
          const content = await resp.text();
          return { sourceKey, content };
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;

      // Build the helper types + .d.ts declarations
      let helperDts = OPENAPI_HELPER_TYPES + "\n";
      for (const result of results) {
        if (!result) continue;
        // Strip 'export' keywords so types are ambient in Monaco
        const ambient = result.content.replace(/^export /gm, "");
        helperDts += ambient + "\n";
      }

      const version = ++toolsLibVersion.current;
      const disposable = jsDefaults.addExtraLib(
        helperDts,
        `file:///node_modules/@types/executor-openapi/v${version}.d.ts`,
      );
      dtsLibDisposables.current.push(disposable);
    });

    return () => {
      cancelled = true;
    };
  }, [dtsUrls]);

  // Update types when tools change (or on first mount)
  useEffect(() => {
    const m = monacoRef.current;
    if (!m) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jsDefaults = (m.languages as any).typescript.javascriptDefaults;

    // Dispose previous tool type declarations
    toolsLibDisposable.current?.dispose();

    const dts = generateToolsDts(tools, dtsSources);

    // Use a versioned filename — disposing + re-adding the same filename
    // can cause the TS worker to serve stale completions from its cache.
    const version = ++toolsLibVersion.current;
    toolsLibDisposable.current = jsDefaults.addExtraLib(
      dts,
      `file:///node_modules/@types/executor-tools/v${version}.d.ts`,
    );
  }, [tools, dtsUrls]);

  // Avoid transient semantic errors while tool metadata is still loading.
  useEffect(() => {
    const m = monacoRef.current;
    if (!m) return;
    setDiagnosticsOptions(m, typesLoading);
  }, [typesLoading]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      envLibDisposable.current?.dispose();
      toolsLibDisposable.current?.dispose();
      for (const d of dtsLibDisposables.current) d.dispose();
    };
  }, []);

  const handleBeforeMount: BeforeMount = (monaco) => {
    monacoRef.current = monaco;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ts = (monaco.languages as any).typescript;

    // Configure JavaScript/TypeScript defaults for our execution environment
    // Code runs inside an AsyncFunction body so top-level await is valid
    // and there are no imports/exports.
    setDiagnosticsOptions(monaco, typesLoading);

    ts.javascriptDefaults.setCompilerOptions({
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      allowNonTsExtensions: true,
      checkJs: true,
      strict: false,
      noEmit: true,
      allowJs: true,
      lib: ["esnext"],
    });

    // Ensure the worker eagerly syncs models so that completions from
    // addExtraLib declarations are available immediately.
    ts.javascriptDefaults.setEagerModelSync(true);

    // Add stable environment declarations (once)
    envLibDisposable.current?.dispose();
    envLibDisposable.current = ts.javascriptDefaults.addExtraLib(
      BASE_ENVIRONMENT_DTS,
      "file:///node_modules/@types/executor-env/index.d.ts",
    );

    // Add initial tool type declarations
    // (will be replaced by useEffect when tools load from the API)
    toolsLibDisposable.current?.dispose();
    const dts = generateToolsDts(tools, dtsSources);
    const version = ++toolsLibVersion.current;
    toolsLibDisposable.current = ts.javascriptDefaults.addExtraLib(
      dts,
      `file:///node_modules/@types/executor-tools/v${version}.d.ts`,
    );

    // Define themes that track the app's light/dark mode.
    monaco.editor.defineTheme("executor-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: "7f8692", fontStyle: "italic" },
        { token: "keyword", foreground: "0f8a6a" },
        { token: "string", foreground: "a46822" },
        { token: "number", foreground: "a46822" },
        { token: "type", foreground: "0f8a6a" },
        { token: "function", foreground: "5c470f" },
        { token: "variable", foreground: "1f2430" },
        { token: "operator", foreground: "6f7785" },
      ],
      colors: {
        "editor.background": "#ffffff",
        "editor.foreground": "#1f2430",
        "editor.lineHighlightBackground": "#f4f7fb",
        "editor.selectionBackground": "#c7def5",
        "editor.inactiveSelectionBackground": "#dbe8f7",
        "editorCursor.foreground": "#0f8a6a",
        "editorLineNumber.foreground": "#9aa3b2",
        "editorLineNumber.activeForeground": "#6f7785",
        "editorIndentGuide.background": "#e3e8ef",
        "editorIndentGuide.activeBackground": "#ccd5e2",
        "editor.selectionHighlightBackground": "#c7def540",
        "editorWidget.background": "#ffffff",
        "editorWidget.border": "#d6dde8",
        "editorSuggestWidget.background": "#ffffff",
        "editorSuggestWidget.border": "#d6dde8",
        "editorSuggestWidget.selectedBackground": "#cfe1f6",
        "editorSuggestWidget.selectedForeground": "#111827",
        "editorSuggestWidget.selectedIconForeground": "#0f8a6a",
        "editorSuggestWidget.highlightForeground": "#0f8a6a",
        "editorHoverWidget.background": "#ffffff",
        "editorHoverWidget.border": "#d6dde8",
        "list.focusBackground": "#cfe1f6",
        "list.focusForeground": "#111827",
        "list.highlightForeground": "#0f8a6a",
        "input.background": "#ffffff",
        "input.border": "#d6dde8",
        "scrollbar.shadow": "#00000000",
        "scrollbarSlider.background": "#c2cad880",
        "scrollbarSlider.hoverBackground": "#a6afbe",
        "scrollbarSlider.activeBackground": "#8f98a8",
        "focusBorder": "#0f8a6a30",
      },
    });

    monaco.editor.defineTheme("executor-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "5a6370", fontStyle: "italic" },
        { token: "keyword", foreground: "6bdfb8" },
        { token: "string", foreground: "c4a46c" },
        { token: "number", foreground: "c4a46c" },
        { token: "type", foreground: "6bdfb8" },
        { token: "function", foreground: "dcdcaa" },
        { token: "variable", foreground: "c8ccd4" },
        { token: "operator", foreground: "8a93a5" },
      ],
      colors: {
        "editor.background": "#0f1117",
        "editor.foreground": "#c8ccd4",
        "editor.lineHighlightBackground": "#161922",
        "editor.selectionBackground": "#264f78",
        "editor.inactiveSelectionBackground": "#1d2536",
        "editorCursor.foreground": "#6bdfb8",
        "editorLineNumber.foreground": "#3a3f4b",
        "editorLineNumber.activeForeground": "#5a6370",
        "editorIndentGuide.background": "#1e2230",
        "editorIndentGuide.activeBackground": "#2a3040",
        "editor.selectionHighlightBackground": "#264f7830",
        "editorWidget.background": "#161922",
        "editorWidget.border": "#2a3040",
        "editorSuggestWidget.background": "#161922",
        "editorSuggestWidget.border": "#2a3040",
        "editorSuggestWidget.selectedBackground": "#1d2a3a",
        "editorSuggestWidget.highlightForeground": "#6bdfb8",
        "editorHoverWidget.background": "#161922",
        "editorHoverWidget.border": "#2a3040",
        "input.background": "#0f1117",
        "input.border": "#2a3040",
        "scrollbar.shadow": "#00000000",
        "scrollbarSlider.background": "#2a304080",
        "scrollbarSlider.hoverBackground": "#3a4050",
        "scrollbarSlider.activeBackground": "#4a5060",
        "focusBorder": "#6bdfb830",
      },
    });
  };

  const monacoTheme = resolvedTheme === "light" ? "executor-light" : "executor-dark";

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;

    // Set up code completions for tools.* trigger
    editor.addAction({
      id: "trigger-tools-suggest",
      label: "Trigger tools suggest",
      keybindings: [],
      run: () => {
        editor.trigger("tools", "editor.action.triggerSuggest", {});
      },
    });
  };

  return (
    <div className={cn("relative", className)}>
      {typesLoading ? (
        <div className="pointer-events-none absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-background/85 px-2 py-1 text-[10px] font-mono text-muted-foreground backdrop-blur-sm">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading tool types...
        </div>
      ) : null}
      <Editor
        height={height}
        language="javascript"
        path="task.js"
        theme={monacoTheme}
        value={value}
        onChange={(v) => onChange(v ?? "")}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        options={{
          minimap: { enabled: false },
          fixedOverflowWidgets: true,
          fontSize: 13,
          lineHeight: 22,
          fontFamily: "var(--font-geist-mono), 'JetBrains Mono', monospace",
          fontLigatures: true,
          tabSize: 2,
          padding: { top: 12, bottom: 12 },
          scrollBeyondLastLine: false,
          renderLineHighlight: "gutter",
          guides: {
            indentation: true,
            bracketPairs: true,
          },
          bracketPairColorization: {
            enabled: true,
          },
          suggest: {
            showMethods: true,
            showFunctions: true,
            showFields: true,
            showVariables: true,
            showModules: true,
            showProperties: true,
            showKeywords: true,
            preview: true,
            shareSuggestSelections: true,
          },
          quickSuggestions: {
            other: true,
            comments: false,
            strings: true,
          },
          acceptSuggestionOnCommitCharacter: true,
          parameterHints: {
            enabled: true,
            cycle: true,
          },
          inlineSuggest: {
            enabled: true,
          },
          wordWrap: "on",
          automaticLayout: true,
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          overviewRulerBorder: false,
          scrollbar: {
            vertical: "auto",
            horizontal: "auto",
            verticalScrollbarSize: 6,
            horizontalScrollbarSize: 6,
          },
          roundedSelection: true,
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          smoothScrolling: true,
        }}
        loading={
          <div className="flex h-full items-center justify-center bg-background text-xs font-mono text-muted-foreground">
            Loading editor...
          </div>
        }
      />
    </div>
  );
}

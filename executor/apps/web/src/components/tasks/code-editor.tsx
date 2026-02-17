"use client";

import { useEffect, useRef } from "react";
import { useQuery as useTanstackQuery } from "@tanstack/react-query";
import Editor, { type OnMount, type BeforeMount, type Monaco } from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import { useTheme } from "next-themes";
import type { ToolDescriptor } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  CODE_EDITOR_OPTIONS,
  configureJavascriptDefaults,
  defineExecutorThemes,
  setDiagnosticsOptions,
} from "./code/editor-monaco";

const PLACEHOLDER_TYPES_DTS = "declare const tools: any;\n";

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  tools: ToolDescriptor[];
  /** Workspace-wide Monaco `.d.ts` bundle URL. */
  typesUrl?: string;
  className?: string;
  height?: string;
}

export function CodeEditor({
  value,
  onChange,
  tools,
  typesUrl,
  className,
  height = "400px",
}: CodeEditorProps) {
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const envLibDisposable = useRef<{ dispose: () => void } | null>(null);
  const toolsLibDisposable = useRef<{ dispose: () => void } | null>(null);
  const toolsLibVersion = useRef(0);

  const typesBundleQuery = useTanstackQuery<string>({
    queryKey: ["executor-tool-types", typesUrl],
    queryFn: async ({ signal }) => {
      if (!typesUrl) {
        throw new Error("No types URL provided");
      }

      const resp = await fetch(typesUrl, { signal });
      if (!resp.ok) {
        throw new Error(`Failed to load tool types: ${resp.status}`);
      }

      return resp.text();
    },
    enabled: Boolean(typesUrl),
    retry: false,
    staleTime: Infinity,
  });

  const typesHydrating = typesBundleQuery.isLoading || typesBundleQuery.isFetching;
  useEffect(() => {
    const m = monacoRef.current;
    if (!m) return;

    const jsDefaults = m.languages.typescript.javascriptDefaults;

    // Dispose previous tool type declarations
    toolsLibDisposable.current?.dispose();

    // Placeholder types until we fetch the workspace bundle.
    const version = ++toolsLibVersion.current;
    toolsLibDisposable.current = jsDefaults.addExtraLib(
      PLACEHOLDER_TYPES_DTS,
      `file:///node_modules/@types/executor-tools/v${version}.d.ts`,
    );
  }, [tools]);

  // Register fetched workspace type bundle.
  useEffect(() => {
    if (!typesBundleQuery.data) {
      return;
    }

    const m = monacoRef.current;
    if (!m) return;

    const jsDefaults = m.languages.typescript.javascriptDefaults;

    toolsLibDisposable.current?.dispose();
    const version = ++toolsLibVersion.current;
    toolsLibDisposable.current = jsDefaults.addExtraLib(
      typesBundleQuery.data,
      `file:///node_modules/@types/executor-tools/v${version}.d.ts`,
    );
  }, [typesBundleQuery.data]);

  // Avoid transient semantic errors while tool metadata is still loading.
  useEffect(() => {
    const m = monacoRef.current;
    if (!m) return;
    setDiagnosticsOptions(m, typesHydrating);
  }, [typesHydrating]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      envLibDisposable.current?.dispose();
      toolsLibDisposable.current?.dispose();
    };
  }, []);

  const handleBeforeMount: BeforeMount = (monaco) => {
    monacoRef.current = monaco;

    const ts = configureJavascriptDefaults(monaco, typesHydrating);

    // Add stable environment declarations (once)
    // Keep a stable environment declaration (console/timers).
    envLibDisposable.current?.dispose();
    envLibDisposable.current = ts.javascriptDefaults.addExtraLib(
      // Minimal env while the workspace bundle is loading.
      `interface Console { log(...args: any[]): void; error(...args: any[]): void; warn(...args: any[]): void; info(...args: any[]): void; debug(...args: any[]): void; }\n` +
        "declare var console: Console;\n" +
        "declare function setTimeout(callback: (...args: any[]) => void, ms?: number, ...args: any[]): number;\n" +
        "declare function clearTimeout(id: number): void;\n" +
        "declare function setInterval(callback: (...args: any[]) => void, ms?: number, ...args: any[]): number;\n" +
        "declare function clearInterval(id: number): void;\n",
      "file:///node_modules/@types/executor-env/index.d.ts",
    );

    // Add initial tool type declarations
    // (will be replaced by useEffect when tools load from the API)
    toolsLibDisposable.current?.dispose();
    const version = ++toolsLibVersion.current;
    toolsLibDisposable.current = ts.javascriptDefaults.addExtraLib(
      PLACEHOLDER_TYPES_DTS,
      `file:///node_modules/@types/executor-tools/v${version}.d.ts`,
    );

    defineExecutorThemes(monaco);
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
      {typesHydrating ? (
        <div className="pointer-events-none absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-background/85 px-2 py-1 text-[10px] font-mono text-muted-foreground backdrop-blur-sm">
          <Loader2 className="h-3 w-3 animate-spin" />
          {tools.length > 0 ? "Loading type definitions..." : "Loading tool metadata..."}
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
        options={CODE_EDITOR_OPTIONS}
        loading={
          <div className="flex h-full w-full items-center justify-center bg-background text-xs font-mono text-muted-foreground">
            <span className="w-full max-w-xs rounded-md border border-border/80 bg-muted/70 px-3 py-1 text-center">
              Loading editor...
            </span>
          </div>
        }
      />
    </div>
  );
}

"use client";

import { useRef, useEffect, useMemo, useState } from "react";
import Editor, { type OnMount, type BeforeMount, type Monaco } from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import { useTheme } from "next-themes";
import type { ToolDescriptor } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  BASE_ENVIRONMENT_DTS,
  OPENAPI_HELPER_TYPES,
  generateToolsDts,
} from "./code/editor-types";
import {
  CODE_EDITOR_OPTIONS,
  configureJavascriptDefaults,
  defineExecutorThemes,
  setDiagnosticsOptions,
} from "./code/editor-monaco";

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
  const [dtsHydrating, setDtsHydrating] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const envLibDisposable = useRef<{ dispose: () => void } | null>(null);
  const toolsLibDisposable = useRef<{ dispose: () => void } | null>(null);
  const dtsLibDisposables = useRef<{ dispose: () => void }[]>([]);
  const toolsLibVersion = useRef(0);
  const fetchedDtsUrls = useRef<string>("");
  const dtsSources = useMemo(() => new Set(Object.keys(dtsUrls ?? {})), [dtsUrls]);
  const toolTypesLoading = typesLoading || dtsHydrating;

  // Fetch and register .d.ts blobs from OpenAPI sources
  useEffect(() => {
    if (!dtsUrls || Object.keys(dtsUrls).length === 0) {
      fetchedDtsUrls.current = "";
      for (const d of dtsLibDisposables.current) d.dispose();
      dtsLibDisposables.current = [];
      void Promise.resolve().then(() => {
        setDtsHydrating(false);
      });
      return;
    }
    const m = monacoRef.current;
    if (!m) return;

    const jsDefaults = m.languages.typescript.javascriptDefaults;

    // Skip if URLs haven't changed
    const urlsKey = JSON.stringify(dtsUrls);
    if (urlsKey === fetchedDtsUrls.current) return;
    fetchedDtsUrls.current = urlsKey;

    // Dispose previous .d.ts libs
    for (const d of dtsLibDisposables.current) d.dispose();
    dtsLibDisposables.current = [];

    let cancelled = false;
    const entries = Object.entries(dtsUrls);

    void Promise.resolve()
      .then(async () => {
        setDtsHydrating(true);
        const results = await Promise.all(
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
        );

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
      })
      .finally(() => {
        if (!cancelled) {
          setDtsHydrating(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [dtsUrls]);

  // Update types when tools change (or on first mount)
  useEffect(() => {
    const m = monacoRef.current;
    if (!m) return;

    const jsDefaults = m.languages.typescript.javascriptDefaults;

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
  }, [tools, dtsSources]);

  // Avoid transient semantic errors while tool metadata is still loading.
  useEffect(() => {
    const m = monacoRef.current;
    if (!m) return;
    setDiagnosticsOptions(m, toolTypesLoading);
  }, [toolTypesLoading]);

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

    const ts = configureJavascriptDefaults(monaco, toolTypesLoading);

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
      {toolTypesLoading ? (
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
          <div className="flex h-full items-center justify-center bg-background text-xs font-mono text-muted-foreground">
            Loading editor...
          </div>
        }
      />
    </div>
  );
}

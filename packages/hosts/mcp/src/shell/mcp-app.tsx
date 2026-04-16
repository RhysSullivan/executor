import "./globals.css";

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useContext,
  Fragment,
  createContext,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { transform } from "sucrase";

import { createToolsProxy, createRunFn } from "./proxy";
import { useQuery, useMutation } from "./hooks";
import * as Components from "./components";

// ---------------------------------------------------------------------------
// Theme application from MCP Apps host context
// ---------------------------------------------------------------------------

function applyTheme(ctx: McpUiHostContext) {
  if (ctx.theme) {
    document.documentElement.classList.toggle("dark", ctx.theme === "dark");
  }
}

// ---------------------------------------------------------------------------
// Component compilation + scoped evaluation
// ---------------------------------------------------------------------------

/** Compile JSX source to plain JS using Sucrase */
function compileJsx(code: string): string {
  const result = transform(code, {
    transforms: ["jsx", "typescript"],
    jsxRuntime: "classic",
    production: true,
  });
  return result.code;
}

/**
 * Find the component to render from the evaluated module.
 * Priority: explicit `App` export → last function defined → any function.
 */
function findComponent(
  exports: Record<string, unknown>,
): React.ComponentType | null {
  // If there's an `App` key, use it
  if (typeof exports.App === "function") return exports.App as React.ComponentType;

  // Otherwise use the last function value
  const fns = Object.values(exports).filter(
    (v) => typeof v === "function",
  ) as React.ComponentType[];
  return fns.length > 0 ? fns[fns.length - 1]! : null;
}

/**
 * Evaluate compiled JS in a scoped context providing React, hooks,
 * components, tools proxy, useQuery/useMutation, and Lucide icons.
 */
function evaluateComponent(
  compiled: string,
  tools: Record<string, unknown>,
  run: (code: string) => Promise<unknown>,
): React.ComponentType | null {
  // Build the scope object that the model's code can access
  const scope: Record<string, unknown> = {
    // React core
    React,
    useState,
    useEffect,
    useRef,
    useCallback,
    useMemo,
    useContext,
    Fragment,
    createContext,

    // Data fetching
    useQuery,
    useMutation,

    // Tools proxy + escape hatch
    tools,
    run,

    // All UI components, icons, chart primitives
    ...Components,
  };

  const scopeKeys = Object.keys(scope);
  const scopeValues = scopeKeys.map((k) => scope[k]);

  // Wrap in a function body that captures all named functions/consts
  // and returns them as an exports object
  const wrappedCode = `
    "use strict";
    const __exports = {};
    ${compiled
      .replace(
        /^(function\s+)(\w+)/gm,
        "$1$2; __exports.$2 = $2; function $2",
      )
      .replace(
        /^(const|let|var)\s+(\w+)\s*=/gm,
        "$1 $2 = __exports.$2 =",
      )}
    return __exports;
  `;

  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function(...scopeKeys, wrappedCode);
    const exports = factory(...scopeValues) as Record<string, unknown>;
    return findComponent(exports);
  } catch (err) {
    console.error("[executor-shell] Failed to evaluate component:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shell App — connects to MCP host, receives code, renders components
// ---------------------------------------------------------------------------

function ShellApp() {
  const [component, setComponent] = useState<React.ComponentType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
  const toolsRef = useRef<Record<string, unknown>>({});
  const runRef = useRef<(code: string) => Promise<unknown>>(() => Promise.resolve(null));

  const { app, error: connectionError } = useApp({
    appInfo: { name: "Executor Shell", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app: App) => {
      // Create the tools proxy and run function
      toolsRef.current = createToolsProxy(app);
      runRef.current = createRunFn(app);

      app.ontoolresult = (result: CallToolResult) => {
        const structured = result.structuredContent as
          | { code?: string }
          | undefined;
        const code = structured?.code;

        if (!code || typeof code !== "string") {
          // Not a generative UI result — show the text
          const text = result.content?.find((c) => c.type === "text")?.text;
          setError(text ?? "No UI code received");
          setComponent(null);
          return;
        }

        try {
          const compiled = compileJsx(code);
          const Component = evaluateComponent(
            compiled,
            toolsRef.current,
            runRef.current,
          );

          if (!Component) {
            setError("No React component found in code");
            setComponent(null);
            return;
          }

          setComponent(() => Component);
          setError(null);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(`Compilation error: ${msg}`);
          setComponent(null);
        }
      };

      app.onerror = (err) => {
        console.error("[executor-shell] App error:", err);
      };

      app.onhostcontextchanged = (ctx: McpUiHostContext) => {
        setHostContext((prev) => ({ ...prev, ...ctx }));
        applyTheme(ctx);
      };

      app.onteardown = async () => {
        return {};
      };
    },
  });

  // Apply initial host context
  useEffect(() => {
    if (app) {
      const ctx = app.getHostContext();
      if (ctx) {
        setHostContext(ctx);
        applyTheme(ctx);
      }
    }
  }, [app]);

  if (connectionError) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <div className="text-destructive text-sm">
          Connection error: {connectionError.message}
        </div>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <div className="text-muted-foreground text-sm">Connecting...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <Components.Alert variant="destructive">
          <Components.AlertCircle className="h-4 w-4" />
          <Components.AlertTitle>Error</Components.AlertTitle>
          <Components.AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {error}
          </Components.AlertDescription>
        </Components.Alert>
      </div>
    );
  }

  if (!component) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <div className="text-muted-foreground text-sm">
          Waiting for UI...
        </div>
      </div>
    );
  }

  const Component = component;

  return (
    <Components.TooltipProvider>
      <div
        className="min-h-full p-4"
        style={{
          paddingTop: hostContext?.safeAreaInsets?.top,
          paddingRight: hostContext?.safeAreaInsets?.right,
          paddingBottom: hostContext?.safeAreaInsets?.bottom,
          paddingLeft: hostContext?.safeAreaInsets?.left,
        }}
      >
        <ErrorBoundary>
          <Component />
        </ErrorBoundary>
      </div>
    </Components.TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Error boundary for catching runtime errors in model-generated components
// ---------------------------------------------------------------------------

class ErrorBoundary extends React.Component<
  { children: ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <Components.Alert variant="destructive">
          <Components.AlertCircle className="h-4 w-4" />
          <Components.AlertTitle>Runtime Error</Components.AlertTitle>
          <Components.AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {this.state.error.message}
            {this.state.error.stack && (
              <pre className="mt-2 text-xs opacity-60">
                {this.state.error.stack}
              </pre>
            )}
          </Components.AlertDescription>
        </Components.Alert>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ShellApp />
  </React.StrictMode>,
);

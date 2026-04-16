import "./globals.css";
import "@tailwindcss/browser";

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
 * Evaluate compiled JS in a scoped context providing React, hooks,
 * components, tools proxy, useQuery/useMutation, and Lucide icons.
 */
function evaluateComponent(
  compiled: string,
  tools: Record<string, unknown>,
  run: (code: string) => Promise<unknown>,
): { component: React.ComponentType } | { error: string } {
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

  // Execute the compiled code and look for a component + optional config.
  // We check well-known names (App, Component, Main) via typeof,
  // which safely returns "undefined" for undeclared variables.
  const wrappedCode = `
    "use strict";
    ${compiled}
    var __comp = null;
    if (typeof App === "function") __comp = App;
    else if (typeof Component === "function") __comp = Component;
    else if (typeof Main === "function") __comp = Main;
    var __cfg = typeof config === "object" && config !== null ? config : {};
    return { component: __comp, config: __cfg };
  `;

  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function(...scopeKeys, wrappedCode);
    const result = factory(...scopeValues) as {
      component: React.ComponentType | null;
      config: Record<string, unknown>;
    };
    if (!result.component) {
      return { error: "No component found. Export a function named App." };
    }
    return { component: result.component, config: result.config };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[executor-shell] Failed to evaluate component:", err);
    return { error: `Evaluation error: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// Shell App — connects to MCP host, receives code, renders components
// ---------------------------------------------------------------------------

function ShellApp() {
  const [component, setComponent] = useState<React.ComponentType | null>(null);
  const [componentConfig, setComponentConfig] = useState<Record<string, unknown>>({});
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

      /** Compile and render a JSX code string as a React component */
      const renderCode = (code: string) => {
        try {
          const compiled = compileJsx(code);
          const evalResult = evaluateComponent(
            compiled,
            toolsRef.current,
            runRef.current,
          );

          if ("error" in evalResult) {
            setError(evalResult.error);
            setComponent(null);
            return;
          }

          setComponent(() => evalResult.component);
          setComponentConfig(evalResult.config);
          setError(null);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(`Compilation error: ${msg}`);
          setComponent(null);
        }
      };

      // Handle tool input — fires on init (including page reload) with
      // the tool arguments. For generative UI the arguments contain { code }.
      app.ontoolinput = (params: { arguments?: Record<string, unknown> }) => {
        const code = params.arguments?.code;
        if (code && typeof code === "string") {
          renderCode(code);
        }
      };

      app.ontoolresult = (result: CallToolResult) => {
        const structured = result.structuredContent as
          | Record<string, unknown>
          | undefined;
        const code = structured?.code;

        if (code && typeof code === "string") {
          renderCode(code);
          return;
        }

        // Not a generative UI result — render a data view
        const DataView = () => {
          const text = result.content?.find((c) => c.type === "text")?.text;
          const isError = (result as { isError?: boolean }).isError;
          const data = structured as Record<string, unknown> | undefined;

          return (
            <Components.Card>
              <Components.CardContent className="pt-4">
                {isError ? (
                  <Components.Alert variant="destructive">
                    <Components.AlertCircle className="h-4 w-4" />
                    <Components.AlertTitle>Error</Components.AlertTitle>
                    <Components.AlertDescription className="font-mono text-xs whitespace-pre-wrap">
                      {text ?? "Unknown error"}
                    </Components.AlertDescription>
                  </Components.Alert>
                ) : (
                  <pre className="text-xs font-mono whitespace-pre-wrap overflow-auto max-h-[80vh]">
                    {data ? JSON.stringify(data, null, 2) : text ?? "(no result)"}
                  </pre>
                )}
              </Components.CardContent>
            </Components.Card>
          );
        };
        setComponent(() => DataView);
        setError(null);
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
  const maxHeight = typeof componentConfig.maxHeight === "number"
    ? componentConfig.maxHeight
    : 800;

  return (
    <Components.TooltipProvider>
      <div
        className="p-4 overflow-y-auto"
        style={{
          maxHeight,
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

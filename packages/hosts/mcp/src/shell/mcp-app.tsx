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

import {
  createToolsProxy,
  createRunFn,
  type TrustedInteraction,
  type TrustedInteractionResponse,
} from "./proxy";
import { useQuery, useMutation } from "./hooks";
import * as Components from "./components";

type EvaluatedComponent =
  | { component: React.ComponentType; config: Record<string, unknown> }
  | { error: string };

type PendingInteraction = TrustedInteraction & {
  resolve: (response: TrustedInteractionResponse) => void;
};

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
): EvaluatedComponent {
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
  const [pendingInteraction, setPendingInteraction] = useState<PendingInteraction | null>(null);
  const toolsRef = useRef<Record<string, unknown>>({});
  const runRef = useRef<(code: string) => Promise<unknown>>(() => Promise.resolve(null));
  const pendingInteractionRef = useRef<PendingInteraction | null>(null);

  const requestTrustedInteraction = useCallback(
    (interaction: TrustedInteraction): Promise<TrustedInteractionResponse> =>
      new Promise((resolve) => {
        if (pendingInteractionRef.current) {
          resolve({ action: "cancel" });
          return;
        }

        const pending = { ...interaction, resolve };
        pendingInteractionRef.current = pending;
        setPendingInteraction(pending);
      }),
    [],
  );

  const completeTrustedInteraction = useCallback((response: TrustedInteractionResponse) => {
    const pending = pendingInteractionRef.current;
    pendingInteractionRef.current = null;
    setPendingInteraction(null);
    pending?.resolve(response);
  }, []);

  const { app, error: connectionError } = useApp({
    appInfo: { name: "Executor Shell", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app: App) => {
      // Create the tools proxy and run function
      toolsRef.current = createToolsProxy(app, requestTrustedInteraction);
      runRef.current = createRunFn(app, requestTrustedInteraction);

      /** Compile and render a JSX code string as a React component */
      const renderCode = (code: string) => {
        try {
          const compiled = compileJsx(code);
          const evalResult = evaluateComponent(compiled, toolsRef.current, runRef.current);

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
        const structured = result.structuredContent as Record<string, unknown> | undefined;
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
                    {data ? JSON.stringify(data, null, 2) : (text ?? "(no result)")}
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
        <div className="text-destructive text-sm">Connection error: {connectionError.message}</div>
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
        <div className="text-muted-foreground text-sm">Waiting for UI...</div>
      </div>
    );
  }

  const Component = component;
  const maxHeight = typeof componentConfig.maxHeight === "number" ? componentConfig.maxHeight : 800;

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
        {pendingInteraction && (
          <TrustedInteractionModal
            key={pendingInteraction.executionId}
            app={app}
            pending={pendingInteraction}
            onComplete={completeTrustedInteraction}
          />
        )}
      </div>
    </Components.TooltipProvider>
  );
}

function TrustedInteractionModal({
  app,
  pending,
  onComplete,
}: {
  app: App;
  pending: PendingInteraction;
  onComplete: (response: TrustedInteractionResponse) => void;
}) {
  const [content, setContent] = useState("{}");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const interaction = pending.interaction;
  const message =
    typeof interaction.message === "string" && interaction.message.length > 0
      ? interaction.message
      : "Approve this action?";
  const url = typeof interaction.url === "string" ? interaction.url : null;
  const requestedSchema =
    typeof interaction.requestedSchema === "object" &&
    interaction.requestedSchema !== null &&
    Object.keys(interaction.requestedSchema).length > 0
      ? interaction.requestedSchema
      : null;

  const approve = () => {
    try {
      const parsed = content.trim().length > 0 ? JSON.parse(content) : {};
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setJsonError("Response content must be a JSON object.");
        return;
      }
      onComplete({ action: "accept", content: parsed as Record<string, unknown> });
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err));
    }
  };

  const openUrl = () => {
    if (!url) return;
    app.openLink({ url }).catch((err: unknown) => {
      console.error("[executor-shell] Failed to open elicitation URL:", err);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg border border-border bg-card text-card-foreground shadow-xl">
        <div className="border-b border-border px-4 py-3">
          <div className="text-sm font-semibold">Approve action</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            This approval is handled by the Executor shell.
          </div>
        </div>
        <div className="space-y-3 px-4 py-4">
          <div className="text-sm">{message}</div>
          {url && (
            <button
              type="button"
              onClick={openUrl}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground hover:bg-muted"
            >
              <Components.ExternalLink className="h-3.5 w-3.5" />
              Open link
            </button>
          )}
          {requestedSchema && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Response content</div>
              <Components.Textarea
                value={content}
                onChange={(event) => {
                  setContent(event.target.value);
                  setJsonError(null);
                }}
                className="min-h-24 font-mono text-xs"
              />
              <pre className="max-h-32 overflow-auto rounded-md bg-muted p-2 text-xs text-muted-foreground">
                {JSON.stringify(requestedSchema, null, 2)}
              </pre>
              {jsonError && <div className="text-xs text-destructive">{jsonError}</div>}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Components.Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onComplete({ action: "cancel" })}
          >
            Cancel
          </Components.Button>
          <Components.Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onComplete({ action: "decline" })}
          >
            Decline
          </Components.Button>
          <Components.Button type="button" size="sm" onClick={approve}>
            Approve
          </Components.Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error boundary for catching runtime errors in model-generated components
// ---------------------------------------------------------------------------

class ErrorBoundary extends React.Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <Components.Alert variant="destructive">
          <Components.AlertCircle className="h-4 w-4" />
          <Components.AlertTitle>Runtime Error</Components.AlertTitle>
          <Components.AlertDescription className="font-mono text-xs whitespace-pre-wrap">
            {this.state.error.message}
            {this.state.error.stack && (
              <pre className="mt-2 text-xs opacity-60">{this.state.error.stack}</pre>
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

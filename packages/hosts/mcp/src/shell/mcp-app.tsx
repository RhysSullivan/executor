import "./globals.css";
import "@tailwindcss/browser";

import React, { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  createToolsProxy,
  createRunFn,
  type TrustedInteraction,
  type TrustedInteractionResponse,
} from "./proxy";
import * as Components from "./components";
import innerRendererScript from "virtual:executor-inner-renderer";

type PendingInteraction = TrustedInteraction & {
  resolve: (response: TrustedInteractionResponse) => void;
};

type ElicitationFieldValue = string | number | boolean | string[];

type ElicitationSchemaField = {
  readonly name: string;
  readonly schema: Record<string, unknown>;
  readonly required: boolean;
};

type ElicitationFormSchema = {
  readonly fields: readonly ElicitationSchemaField[];
};

type SelectOption = {
  readonly value: string;
  readonly label: string;
};

type RendererState = {
  token: string;
  code: string;
  srcDoc: string;
  config: Record<string, unknown>;
  height: number;
};

type RendererRequest =
  | {
      type: "executor.toolCall";
      requestId: number;
      token: string;
      path: unknown;
      args: unknown;
    }
  | { type: "executor.run"; requestId: number; token: string; code: unknown }
  | { type: "executor.renderer.ready"; token: string }
  | { type: "executor.renderer.config"; token: string; config: unknown }
  | { type: "executor.renderer.size"; token: string; height: unknown }
  | { type: "executor.renderer.error"; token: string; message: unknown };

// ---------------------------------------------------------------------------
// Theme application from MCP Apps host context
// ---------------------------------------------------------------------------

function applyTheme(ctx: McpUiHostContext) {
  if (ctx.theme) {
    document.documentElement.classList.toggle("dark", ctx.theme === "dark");
  }
}

const createRendererToken = (): string => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `renderer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
};

const escapeInlineHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const escapeStyleContent = (value: string): string => value.replace(/<\/style/gi, "<\\/style");

const escapeScriptContent = (value: string): string => value.replace(/<\/script/gi, "<\\/script");

const collectShellCss = (): string =>
  Array.from(document.styleSheets)
    .map((sheet) => {
      try {
        return Array.from(sheet.cssRules)
          .map((rule) => rule.cssText)
          .join("\n");
      } catch {
        return "";
      }
    })
    .filter((css) => css.length > 0)
    .join("\n");

const buildRendererSrcDoc = (token: string): string => {
  const css = collectShellCss();
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="executor-render-token" content="${escapeInlineHtml(token)}">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'">
    <style>${escapeStyleContent(css)}</style>
  </head>
  <body>
    <div id="root"></div>
    <script>${escapeScriptContent(innerRendererScript)}</script>
  </body>
</html>`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const toOptionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const fieldLabel = (field: ElicitationSchemaField): string =>
  toOptionalString(field.schema.title) ?? field.name;

const fieldDescription = (field: ElicitationSchemaField): string | undefined =>
  toOptionalString(field.schema.description);

const enumOptions = (schema: Record<string, unknown>): readonly SelectOption[] => {
  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf)) {
    return oneOf.flatMap((item): SelectOption[] => {
      if (!isRecord(item) || typeof item.const !== "string") return [];
      return [{ value: item.const, label: toOptionalString(item.title) ?? item.const }];
    });
  }

  const values = schema.enum;
  if (!isStringArray(values)) return [];
  const labels = isStringArray(schema.enumNames) ? schema.enumNames : values;
  return values.map((value, index) => ({ value, label: labels[index] ?? value }));
};

const multiSelectOptions = (schema: Record<string, unknown>): readonly SelectOption[] => {
  const items = schema.items;
  if (!isRecord(items)) return [];

  const anyOf = items.anyOf;
  if (Array.isArray(anyOf)) {
    return anyOf.flatMap((item): SelectOption[] => {
      if (!isRecord(item) || typeof item.const !== "string") return [];
      return [{ value: item.const, label: toOptionalString(item.title) ?? item.const }];
    });
  }

  const values = items.enum;
  if (!isStringArray(values)) return [];
  const labels = isStringArray(items.enumNames) ? items.enumNames : values;
  return values.map((value, index) => ({ value, label: labels[index] ?? value }));
};

const parseElicitationFormSchema = (value: unknown): ElicitationFormSchema | null => {
  if (!isRecord(value) || !isRecord(value.properties)) return null;
  const required = isStringArray(value.required) ? value.required : [];
  const fields = Object.entries(value.properties).flatMap(
    ([name, schema]): ElicitationSchemaField[] =>
      isRecord(schema) ? [{ name, schema, required: required.includes(name) }] : [],
  );
  return fields.length > 0 ? { fields } : null;
};

const initialFieldValue = (field: ElicitationSchemaField): ElicitationFieldValue | undefined => {
  const value = field.schema.default;
  if (value === undefined) return undefined;
  if (field.schema.type === "boolean") return value === true;
  if (field.schema.type === "number" || field.schema.type === "integer") {
    const numberValue = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  if (field.schema.type === "array") {
    return isStringArray(value) ? value : undefined;
  }
  return typeof value === "string" ? value : String(value);
};

const initialFormValues = (
  formSchema: ElicitationFormSchema | null,
): Record<string, ElicitationFieldValue> => {
  const values: Record<string, ElicitationFieldValue> = {};
  for (const field of formSchema?.fields ?? []) {
    const value = initialFieldValue(field);
    if (value !== undefined) values[field.name] = value;
  }
  return values;
};

const isEmptyFormValue = (value: ElicitationFieldValue | undefined): boolean =>
  value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

const numericConstraint = (
  schema: Record<string, unknown>,
  key: "minimum" | "maximum",
): number | undefined => (typeof schema[key] === "number" ? schema[key] : undefined);

const lengthConstraint = (
  schema: Record<string, unknown>,
  key: "minLength" | "maxLength" | "minItems" | "maxItems",
): number | undefined => (typeof schema[key] === "number" ? schema[key] : undefined);

const validateEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const validateUrl = (value: string): boolean => {
  try {
    void new URL(value);
    return true;
  } catch {
    return false;
  }
};

const validateFieldValue = (
  field: ElicitationSchemaField,
  value: ElicitationFieldValue | undefined,
): { value?: ElicitationFieldValue; error?: string } => {
  if (isEmptyFormValue(value)) {
    return field.required ? { error: "This field is required." } : {};
  }

  if (field.schema.type === "boolean") {
    return typeof value === "boolean" ? { value } : { error: "Choose true or false." };
  }

  if (field.schema.type === "number" || field.schema.type === "integer") {
    const numberValue = typeof value === "number" ? value : Number(value);
    const typeLabel = field.schema.type === "integer" ? "an integer" : "a number";
    if (!Number.isFinite(numberValue)) return { error: `Must be ${typeLabel}.` };
    if (field.schema.type === "integer" && !Number.isInteger(numberValue)) {
      return { error: "Must be an integer." };
    }
    const minimum = numericConstraint(field.schema, "minimum");
    const maximum = numericConstraint(field.schema, "maximum");
    if (minimum !== undefined && numberValue < minimum) return { error: `Must be >= ${minimum}.` };
    if (maximum !== undefined && numberValue > maximum) return { error: `Must be <= ${maximum}.` };
    return { value: numberValue };
  }

  if (field.schema.type === "array") {
    const selected = Array.isArray(value) ? value : [];
    const options = multiSelectOptions(field.schema);
    const allowed = new Set(options.map((option) => option.value));
    if (!selected.every((item) => allowed.has(item))) return { error: "Choose a valid option." };
    const minItems = lengthConstraint(field.schema, "minItems");
    const maxItems = lengthConstraint(field.schema, "maxItems");
    if (minItems !== undefined && selected.length < minItems) {
      return { error: `Choose at least ${minItems} option${minItems === 1 ? "" : "s"}.` };
    }
    if (maxItems !== undefined && selected.length > maxItems) {
      return { error: `Choose at most ${maxItems} option${maxItems === 1 ? "" : "s"}.` };
    }
    return { value: selected };
  }

  const stringValue = String(value);
  const options = enumOptions(field.schema);
  if (options.length > 0 && !options.some((option) => option.value === stringValue)) {
    return { error: "Choose a valid option." };
  }
  const minLength = lengthConstraint(field.schema, "minLength");
  const maxLength = lengthConstraint(field.schema, "maxLength");
  if (minLength !== undefined && stringValue.length < minLength) {
    return { error: `Must be at least ${minLength} character${minLength === 1 ? "" : "s"}.` };
  }
  if (maxLength !== undefined && stringValue.length > maxLength) {
    return { error: `Must be at most ${maxLength} character${maxLength === 1 ? "" : "s"}.` };
  }
  if (field.schema.format === "email" && !validateEmail(stringValue)) {
    return { error: "Must be a valid email address." };
  }
  if (field.schema.format === "uri" && !validateUrl(stringValue)) {
    return { error: "Must be a valid URL." };
  }
  return { value: stringValue };
};

const buildElicitationContent = (
  formSchema: ElicitationFormSchema | null,
  formValues: Record<string, ElicitationFieldValue>,
): {
  content?: Record<string, unknown>;
  errors: Record<string, string>;
} => {
  if (!formSchema) return { content: {}, errors: {} };

  const content: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of formSchema.fields) {
    const result = validateFieldValue(field, formValues[field.name]);
    if (result.error) {
      errors[field.name] = result.error;
      continue;
    }
    if (result.value !== undefined) content[field.name] = result.value;
  }
  return { content, errors };
};

const TOOL_PATH_SEGMENT = /^[A-Za-z_$][\w$]*$/;

const toolPathToCode = (path: unknown, args: unknown): string => {
  if (!Array.isArray(path) || path.length === 0) {
    throw new Error("Invalid tool path.");
  }
  const parts = path.map((part) => {
    if (typeof part !== "string" || !TOOL_PATH_SEGMENT.test(part)) {
      throw new Error("Invalid tool path.");
    }
    return part;
  });
  const argList = Array.isArray(args) ? args : [];
  const serializedArgs = JSON.stringify(argList[0] ?? {});
  return `return await tools.${parts.join(".")}(${serializedArgs})`;
};

// ---------------------------------------------------------------------------
// Shell App — connects to MCP host, receives code, renders components
// ---------------------------------------------------------------------------

function ShellApp() {
  const [component, setComponent] = useState<React.ComponentType | null>(null);
  const [renderer, setRenderer] = useState<RendererState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
  const [pendingInteraction, setPendingInteraction] = useState<PendingInteraction | null>(null);
  const toolsRef = useRef<Record<string, unknown>>({});
  const runRef = useRef<(code: string) => Promise<unknown>>(() => Promise.resolve(null));
  const pendingInteractionRef = useRef<PendingInteraction | null>(null);
  const rendererFrameRef = useRef<HTMLIFrameElement | null>(null);
  const rendererRef = useRef<RendererState | null>(null);

  useEffect(() => {
    rendererRef.current = renderer;
  }, [renderer]);

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

  const postToRenderer = useCallback((message: Record<string, unknown>) => {
    const current = rendererRef.current;
    const target = rendererFrameRef.current?.contentWindow;
    if (!current || !target) return;
    target.postMessage({ ...message, token: current.token }, "*");
  }, []);

  useEffect(() => {
    const handleRendererMessage = (event: MessageEvent<RendererRequest>) => {
      const current = rendererRef.current;
      if (!current || event.source !== rendererFrameRef.current?.contentWindow) return;
      const data = event.data;
      if (!isRecord(data) || data.token !== current.token) return;
      const source = event.source;
      if (!source || typeof source.postMessage !== "function") return;
      const respond = (requestId: number, ok: boolean, value?: unknown, error?: string) => {
        source.postMessage(
          {
            type: "executor.response",
            requestId,
            token: current.token,
            ok,
            value,
            error,
          },
          "*",
        );
      };

      if (data.type === "executor.renderer.ready") {
        postToRenderer({
          type: "executor.render",
          code: current.code,
          theme: hostContext?.theme,
        });
        return;
      }

      if (data.type === "executor.renderer.config") {
        setRenderer((prev) =>
          prev && prev.token === current.token
            ? { ...prev, config: isRecord(data.config) ? data.config : {} }
            : prev,
        );
        return;
      }

      if (data.type === "executor.renderer.size") {
        const height = typeof data.height === "number" ? Math.ceil(data.height) : current.height;
        setRenderer((prev) =>
          prev && prev.token === current.token
            ? { ...prev, height: Math.max(120, Math.min(4000, height)) }
            : prev,
        );
        return;
      }

      if (data.type === "executor.renderer.error") {
        if (typeof data.message === "string") {
          console.error("[executor-shell] Renderer error:", data.message);
        }
        return;
      }

      if (data.type === "executor.run") {
        if (typeof data.code !== "string") {
          respond(data.requestId, false, undefined, "Invalid run payload.");
          return;
        }
        runRef
          .current(data.code)
          .then((value) => respond(data.requestId, true, value))
          .catch((err: unknown) =>
            respond(
              data.requestId,
              false,
              undefined,
              err instanceof Error ? err.message : String(err),
            ),
          );
        return;
      }

      if (data.type === "executor.toolCall") {
        let code: string;
        try {
          code = toolPathToCode(data.path, data.args);
        } catch (err) {
          respond(
            data.requestId,
            false,
            undefined,
            err instanceof Error ? err.message : String(err),
          );
          return;
        }
        runRef
          .current(code)
          .then((value) => respond(data.requestId, true, value))
          .catch((err: unknown) =>
            respond(
              data.requestId,
              false,
              undefined,
              err instanceof Error ? err.message : String(err),
            ),
          );
      }
    };

    window.addEventListener("message", handleRendererMessage);
    return () => window.removeEventListener("message", handleRendererMessage);
  }, [hostContext?.theme, postToRenderer]);

  useEffect(() => {
    if (renderer) {
      postToRenderer({ type: "executor.theme", theme: hostContext?.theme });
    }
  }, [hostContext?.theme, postToRenderer, renderer]);

  const { app, error: connectionError } = useApp({
    appInfo: { name: "Executor Shell", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (app: App) => {
      // Create the tools proxy and run function
      toolsRef.current = createToolsProxy(app, requestTrustedInteraction);
      runRef.current = createRunFn(app, requestTrustedInteraction);

      /** Render a JSX code string in the sandboxed inner iframe. */
      const renderCode = (code: string) => {
        try {
          const token = createRendererToken();
          const nextRenderer = {
            token,
            code,
            srcDoc: buildRendererSrcDoc(token),
            config: {},
            height: 240,
          };
          rendererRef.current = nextRenderer;
          setRenderer(nextRenderer);
          setComponent(null);
          setError(null);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(`Compilation error: ${msg}`);
          setComponent(null);
          rendererRef.current = null;
          setRenderer(null);
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
        rendererRef.current = null;
        setRenderer(null);
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
        <ShellLoadingState label="Connecting" />
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

  if (!component && !renderer) {
    return (
      <div
        data-testid="shell-loading-state"
        className="flex min-h-[220px] items-center justify-center p-4"
      >
        <ShellLoadingState label="Preparing interactive UI" />
      </div>
    );
  }

  const Component = component;
  const config = renderer?.config ?? {};
  const maxHeight = typeof config.maxHeight === "number" ? config.maxHeight : 800;
  const rendererHeight = renderer ? Math.min(renderer.height, maxHeight) : undefined;

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
        {renderer ? (
          <iframe
            key={renderer.token}
            ref={rendererFrameRef}
            sandbox="allow-scripts"
            srcDoc={renderer.srcDoc}
            title="Generated UI"
            className="block w-full border-0 bg-background"
            style={{ height: rendererHeight }}
          />
        ) : Component ? (
          <ErrorBoundary>
            <Component />
          </ErrorBoundary>
        ) : null}
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

function ShellLoadingState({ label }: { label: string }) {
  return (
    <div className="w-full max-w-md rounded-lg border border-border bg-card/70 p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <Components.Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{label}</div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
            <span className="h-1.5 w-10 animate-pulse rounded-full bg-muted" />
            <span className="h-1.5 w-16 animate-pulse rounded-full bg-muted" />
          </div>
        </div>
      </div>
      <div className="mt-4 space-y-2">
        <Components.Skeleton className="h-2.5 w-11/12" />
        <Components.Skeleton className="h-2.5 w-7/12" />
        <Components.Skeleton className="h-16 w-full rounded-md" />
      </div>
    </div>
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
  const interaction = pending.interaction;
  const message =
    typeof interaction.message === "string" && interaction.message.length > 0
      ? interaction.message
      : "Approve this action?";
  const url = typeof interaction.url === "string" ? interaction.url : null;
  const formSchema = useMemo(
    () => parseElicitationFormSchema(interaction.requestedSchema),
    [interaction.requestedSchema],
  );
  const [formValues, setFormValues] = useState<Record<string, ElicitationFieldValue>>(() =>
    initialFormValues(formSchema),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setFormValues(initialFormValues(formSchema));
    setFieldErrors({});
  }, [formSchema]);

  const approve = () => {
    const result = buildElicitationContent(formSchema, formValues);
    setFieldErrors(result.errors);
    if (Object.keys(result.errors).length > 0) return;
    onComplete({ action: "accept", content: result.content });
  };

  const setFieldValue = (name: string, value: ElicitationFieldValue | undefined) => {
    setFormValues((prev) => {
      const next = { ...prev };
      if (value === undefined) {
        delete next[name];
      } else {
        next[name] = value;
      }
      return next;
    });
    setFieldErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const openUrl = () => {
    if (!url) return;
    app.openLink({ url }).catch((err: unknown) => {
      console.error("[executor-shell] Failed to open elicitation URL:", err);
    });
  };

  return (
    <div
      data-testid="trusted-interaction-modal"
      className="fixed inset-0 z-50 overflow-y-auto bg-black/45 p-2 backdrop-blur-sm"
    >
      <div className="flex min-h-full items-start justify-center">
        <div
          data-testid="trusted-interaction-card"
          className="flex max-h-[calc(100vh-1rem)] w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-xl"
        >
          <div className="shrink-0 border-b border-border px-4 py-3">
            <div className="text-sm font-semibold">Approve action</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              This approval is handled by the Executor shell.
            </div>
          </div>
          <div
            data-testid="trusted-interaction-body"
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
          >
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
            {formSchema && (
              <div data-testid="trusted-interaction-fields" className="space-y-3">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">
                    Additional details
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    These values will be sent with approval.
                  </div>
                </div>
                {formSchema.fields.map((field) => (
                  <TrustedInteractionField
                    key={field.name}
                    field={field}
                    value={formValues[field.name]}
                    error={fieldErrors[field.name]}
                    onChange={(value) => setFieldValue(field.name, value)}
                  />
                ))}
              </div>
            )}
          </div>
          <div
            data-testid="trusted-interaction-footer"
            className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3"
          >
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
    </div>
  );
}

function TrustedInteractionField({
  field,
  value,
  error,
  onChange,
}: {
  field: ElicitationSchemaField;
  value: ElicitationFieldValue | undefined;
  error: string | undefined;
  onChange: (value: ElicitationFieldValue | undefined) => void;
}) {
  const label = fieldLabel(field);
  const description = fieldDescription(field);
  const fieldId = `trusted-interaction-field-${field.name}`;
  const describedBy = description ? `${fieldId}-description` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;
  const ariaDescribedBy = [describedBy, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5" data-testid={`trusted-interaction-field-${field.name}`}>
      <div className="flex items-center justify-between gap-3">
        <Components.Label htmlFor={fieldId} className="text-xs font-medium">
          {label}
          {field.required && <span className="ml-1 text-destructive">*</span>}
        </Components.Label>
      </div>
      <TrustedInteractionFieldControl
        field={field}
        fieldId={fieldId}
        value={value}
        ariaDescribedBy={ariaDescribedBy}
        invalid={Boolean(error)}
        onChange={onChange}
      />
      {description && (
        <div id={describedBy} className="text-xs text-muted-foreground">
          {description}
        </div>
      )}
      {error && (
        <div id={errorId} className="text-xs text-destructive">
          {error}
        </div>
      )}
    </div>
  );
}

function TrustedInteractionFieldControl({
  field,
  fieldId,
  value,
  ariaDescribedBy,
  invalid,
  onChange,
}: {
  field: ElicitationSchemaField;
  fieldId: string;
  value: ElicitationFieldValue | undefined;
  ariaDescribedBy: string | undefined;
  invalid: boolean;
  onChange: (value: ElicitationFieldValue | undefined) => void;
}) {
  const options = enumOptions(field.schema);
  if (options.length > 0) {
    return (
      <select
        id={fieldId}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid}
        className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20"
      >
        <option value="">Select...</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  const multiOptions = multiSelectOptions(field.schema);
  if (multiOptions.length > 0) {
    const selected = Array.isArray(value) ? value : [];
    return (
      <div
        id={fieldId}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid}
        className="space-y-1.5 rounded-md border border-border p-2"
      >
        {multiOptions.map((option) => {
          const checked = selected.includes(option.value);
          return (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <Components.Checkbox
                checked={checked}
                onCheckedChange={(nextChecked) => {
                  const next = nextChecked === true;
                  onChange(
                    next
                      ? [...selected, option.value]
                      : selected.filter((item) => item !== option.value),
                  );
                }}
              />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
    );
  }

  if (field.schema.type === "boolean") {
    return (
      <label className="flex items-center gap-2 rounded-md border border-border p-2 text-sm">
        <Components.Checkbox
          id={fieldId}
          checked={value === true}
          onCheckedChange={(nextChecked) => onChange(nextChecked === true)}
          aria-describedby={ariaDescribedBy}
          aria-invalid={invalid}
        />
        <span>Yes</span>
      </label>
    );
  }

  if (field.schema.type === "number" || field.schema.type === "integer") {
    return (
      <Components.Input
        id={fieldId}
        type="number"
        value={value === undefined ? "" : String(value)}
        step={field.schema.type === "integer" ? 1 : "any"}
        min={numericConstraint(field.schema, "minimum")}
        max={numericConstraint(field.schema, "maximum")}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid}
      />
    );
  }

  const isLongText = typeof field.schema.maxLength === "number" && field.schema.maxLength > 160;
  if (field.schema.type === "string" && isLongText && field.schema.format === undefined) {
    return (
      <Components.Textarea
        id={fieldId}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid}
        className="min-h-20"
      />
    );
  }

  const inputType =
    field.schema.format === "email" ? "email" : field.schema.format === "uri" ? "url" : "text";
  return (
    <Components.Input
      id={fieldId}
      type={inputType}
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value)}
      aria-describedby={ariaDescribedBy}
      aria-invalid={invalid}
    />
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

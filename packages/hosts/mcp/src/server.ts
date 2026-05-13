import { Effect, Match, Option, Schema } from "effect";
import * as Cause from "effect/Cause";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type {
  jsonSchemaValidator,
  JsonSchemaType,
  JsonSchemaValidator,
} from "@modelcontextprotocol/sdk/validation/types.js";
import {
  getUiCapability,
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { Validator } from "@cfworker/json-schema";
import { z } from "zod/v4";

import type {
  ElicitationResponse,
  ElicitationHandler,
  ElicitationContext,
  ElicitationRequest,
} from "@executor-js/sdk";
import type * as Tracer from "effect/Tracer";
import {
  createExecutionEngine,
  formatExecuteResult,
  formatPausedExecution,
  type ExecutionEngine,
  type ExecutionEngineConfig,
} from "@executor-js/execution";

// ---------------------------------------------------------------------------
// Workers-compatible JSON Schema validator (replaces Ajv which uses new Function())
// ---------------------------------------------------------------------------

class CfWorkerJsonSchemaValidator implements jsonSchemaValidator {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const validator = new Validator(schema as Record<string, unknown>, "2020-12", false);
    return (input: unknown) => {
      const result = validator.validate(input);
      if (result.valid) {
        return { valid: true, data: input as T, errorMessage: undefined };
      }
      const errorMessage = result.errors.map((e) => `${e.instanceLocation}: ${e.error}`).join("; ");
      return { valid: false, data: undefined, errorMessage };
    };
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type SharedMcpServerConfig = {
  /**
   * Pre-built `execute` tool description. When provided, the factory skips
   * its internal `engine.getDescription` yield. Useful when the caller
   * wants to compute the description inside its own Effect tracer context
   * so sub-spans (`executor.sources.list`, `executor.tools.list`) nest as
   * children of the caller's root span.
   */
  readonly description?: string;
  /**
   * Parent span override for engine calls. The factory captures the
   * caller's context at construction time, but `Effect.runPromiseWith`
   * starts a fresh fiber per SDK callback — so the `currentSpan`
   * FiberRef resets to root unless explicitly anchored.
   *
   * Accepts either a fixed span (per-request McpServer instances) or a
   * getter (session-scoped instances that need to anchor each callback
   * under whichever request triggered it; see the Cloud DO).
   */
  readonly parentSpan?: Tracer.AnySpan | (() => Tracer.AnySpan | undefined);
  /**
   * Enable verbose MCP capability / elicitation debug logging.
   */
  readonly debug?: boolean;
};

export type ExecutorMcpServerConfig<E extends Cause.YieldableError = Cause.YieldableError> =
  | (ExecutionEngineConfig<E> & SharedMcpServerConfig)
  | ({ readonly engine: ExecutionEngine<E> } & SharedMcpServerConfig)
  | (ExecutionEngineConfig<E> & SharedMcpServerConfig & { readonly stateless: true })
  | ({ readonly engine: ExecutionEngine<E>; readonly stateless: true } & SharedMcpServerConfig);

type McpAppsClientCapabilities = ClientCapabilities & {
  readonly extensions?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// MCP Apps UI shell
// ---------------------------------------------------------------------------

const SHELL_RESOURCE_URI = "ui://executor/shell.html";

const SHADCN_COMPONENTS =
  "Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Button, Input, Textarea, Label, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Checkbox, Switch, Slider, Toggle, Tabs, TabsList, TabsTrigger, TabsContent, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Badge, Avatar, AvatarFallback, Alert, AlertTitle, AlertDescription, Dialog, Sheet, Popover, Tooltip, Separator, ScrollArea, Skeleton, Progress, Accordion, AccordionItem, AccordionTrigger, AccordionContent, DropdownMenu + sub-components";

const RECHARTS_COMPONENTS =
  "BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend, ChartContainer, ChartTooltip, ChartTooltipContent";

const LUCIDE_ICONS =
  "Plus, Minus, Check, X, Search, Loader2, AlertCircle, ExternalLink, Copy, Trash2, Edit, Settings, User, Globe, Star, TrendingUp, Activity, Database, Shield, Package, and more";

const sectionStart = (text: string, heading: string): number => {
  const withNewline = text.indexOf(`\n${heading}`);
  if (withNewline >= 0) return withNewline + 1;
  return text.startsWith(heading) ? 0 : -1;
};

const availableNamespacesSection = (description: string): string | undefined => {
  const start = sectionStart(description, "## Available namespaces");
  return start >= 0 ? description.slice(start).trim() : undefined;
};

const stripGenerativeUiSection = (description: string): string => {
  const start = sectionStart(description, "## Generative UI");
  if (start < 0) return description;

  const namespaces = availableNamespacesSection(description);
  const before = description.slice(0, start).trimEnd();
  return namespaces ? `${before}\n\n${namespaces}` : before;
};

const extractGenerativeUiBody = (description: string): string | undefined => {
  const start = sectionStart(description, "## Generative UI");
  if (start < 0) return undefined;

  const namespaces = availableNamespacesSection(description);
  const end = namespaces ? description.indexOf(namespaces) : description.length;
  const section = description.slice(start, end).trim();
  return section.replace(/^## Generative UI\s*/, "").trim();
};

const buildRenderUiDescription = (executeDescription: string): string => {
  const uiBody =
    extractGenerativeUiBody(executeDescription) ??
    [
      "Write a React component named `App` with JSX in the `code` parameter. It renders in an MCP app iframe alongside the conversation.",
      "",
      "**No imports** — everything is already in scope:",
      "- React: `useState`, `useEffect`, `useRef`, `useCallback`, `useMemo`",
      "- Data fetching: `useQuery(fn)` -> `{ data, error, isLoading, refetch }`, `useMutation(fn)` -> `{ mutate, data, error, isPending }`",
      "- Fetch live data inside the generated component with `useQuery(() => tools.<namespace>.<tool>(args))`. Do not call tools before generating the UI and paste returned data into JSX.",
      "- For user-triggered writes or actions, use `useMutation((input) => tools.<namespace>.<tool>(input))` and call `mutate(input)` from event handlers.",
      "- Only hardcode small display constants like labels, colors, tab names, and chart configuration. Never embed tool response rows, API results, summaries, or dashboard data as literals in the component.",
      "- Always render loading and error states from `useQuery` / `useMutation`; do not replace them with hardcoded fallback data.",
      `- shadcn/ui components available by name: ${SHADCN_COMPONENTS}`,
      `- Recharts components available by name: ${RECHARTS_COMPONENTS}`,
      `- Lucide icons available by name: ${LUCIDE_ICONS}`,
    ].join("\n");

  const namespaces = availableNamespacesSection(executeDescription);
  return [
    "Render an interactive React UI component in an MCP app iframe.",
    "",
    "## Workflow",
    "",
    "1. Write a component named `App` in the `code` parameter.",
    "2. Fetch all live data inside `App` with `useQuery(() => tools.<namespace>.<tool>(args))`.",
    "3. Use `useMutation((input) => tools.<namespace>.<tool>(input))` for user-triggered writes or actions.",
    "4. Return only the component code.",
    "",
    "## Available UI Components",
    "",
    `- shadcn/ui components available by name: ${SHADCN_COMPONENTS}`,
    `- Recharts components available by name: ${RECHARTS_COMPONENTS}`,
    `- Lucide icons available by name: ${LUCIDE_ICONS}`,
    "",
    "## Rules",
    "",
    "- Use this tool instead of `execute` whenever the output should be an interactive UI.",
    "- Do not call API tools first and paste returned data into JSX.",
    "- Do not embed tool response rows, API results, summaries, dashboard data, or copied query output as literals in the component.",
    "- Keep data live by routing every API read/write through the provided `tools` proxy from `useQuery`, `useMutation`, or `run(code)`.",
    "- The server rejects obvious hardcoded live-data snapshots such as `const rows = [{...}, {...}]`; regenerate with `useQuery` instead.",
    "",
    "## Generative UI",
    "",
    uiBody,
    ...(namespaces ? ["", namespaces] : []),
  ].join("\n");
};

const DATA_SNAPSHOT_NAME =
  /(?:^|_|\b)(?:data|rows|items|results|records|datasets|dashboards|logs|events|metrics|traces|services|endpoints|series|points|stats|summary|requests|errors|users|issues|tickets)(?:$|_|\b)/i;

const OBJECT_ARRAY_LITERAL =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[((?:[^\][{}]|\{[^{}]*\})*)\]/gs;

const validateRenderUiCode = (code: string): string | null => {
  for (const match of code.matchAll(OBJECT_ARRAY_LITERAL)) {
    const name = match[1];
    const body = match[2] ?? "";
    const objectCount = body.match(/\{/g)?.length ?? 0;
    if (DATA_SNAPSHOT_NAME.test(name) && objectCount >= 2) {
      return [
        `Hardcoded live-data array "${name}" is not allowed in render-ui.`,
        "Fetch the data inside App with useQuery(() => tools.<namespace>.<tool>(args)) and derive rows/cards/charts from the query result.",
      ].join(" ");
    }
  }

  return null;
};

let shellHtmlCache: string | undefined;

const loadShellHtml = async (): Promise<string> => {
  if (shellHtmlCache) return shellHtmlCache;

  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: optional prebuilt shell asset is loaded from local filesystem when present
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const candidates = [
      path.join(import.meta.dirname, "../dist/mcp-app.html"),
      path.join(import.meta.dirname, "../../dist/mcp-app.html"),
    ];

    for (const candidate of candidates) {
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: try each possible emitted shell path before falling back
      try {
        shellHtmlCache = await fs.readFile(candidate, "utf-8");
        return shellHtmlCache;
      } catch {
        // Try the next candidate path.
      }
    }
  } catch {
    // Fall through to the development fallback below.
  }

  shellHtmlCache =
    "<!doctype html><html><body><p>Shell not built. Run: bun run --cwd packages/hosts/mcp build:shell</p></body></html>";
  return shellHtmlCache;
};

// ---------------------------------------------------------------------------
// Elicitation bridge
// ---------------------------------------------------------------------------

const getElicitationSupport = (server: McpServer): { form: boolean; url: boolean } => {
  const capabilities = server.server.getClientCapabilities();
  if (capabilities === undefined || !capabilities.elicitation) return { form: false, url: false };
  const elicitation = capabilities.elicitation as Record<string, unknown>;
  return { form: Boolean(elicitation.form), url: Boolean(elicitation.url) };
};

const readDebugDefault = (): boolean => {
  if (typeof process === "undefined" || !process.env) return false;
  const value = process.env.EXECUTOR_MCP_DEBUG;
  return value === "1" || value === "true";
};

const supportsManagedElicitation = (server: McpServer): boolean =>
  getElicitationSupport(server).form;

const capabilitySnapshot = (server: McpServer) => ({
  clientCapabilities: server.server.getClientCapabilities() ?? null,
  elicitationSupport: getElicitationSupport(server),
  managedElicitation: supportsManagedElicitation(server),
});

type ElicitInputParams =
  | {
      mode?: "form";
      message: string;
      requestedSchema: { readonly [key: string]: unknown };
    }
  | { mode: "url"; message: string; url: string; elicitationId: string };

const elicitationRequestTag = (request: ElicitationRequest): ElicitationRequest["_tag"] =>
  Match.value(request).pipe(
    Match.tag("UrlElicitation", () => "UrlElicitation" as const),
    Match.tag("FormElicitation", () => "FormElicitation" as const),
    Match.exhaustive,
  );

const requestedSchemaIsNonEmpty = (request: ElicitationRequest): boolean =>
  Match.value(request).pipe(
    Match.tag("FormElicitation", (req) => Object.keys(req.requestedSchema).length > 0),
    Match.tag("UrlElicitation", () => false),
    Match.exhaustive,
  );

const elicitationRequestUrl = (request: ElicitationRequest): string | undefined =>
  Match.value(request).pipe(
    Match.tag("UrlElicitation", (req): string | undefined => req.url),
    Match.tag("FormElicitation", (): string | undefined => undefined),
    Match.exhaustive,
  );

const pausedInteractionKind = (request: ElicitationRequest): ElicitationRequest["_tag"] =>
  elicitationRequestTag(request);

const elicitationRequestToParams: (request: ElicitationRequest) => ElicitInputParams =
  Match.type<ElicitationRequest>().pipe(
    Match.tag("UrlElicitation", (req) => ({
      mode: "url" as const,
      message: req.message,
      url: req.url,
      elicitationId: req.elicitationId,
    })),
    Match.tag("FormElicitation", (req) => ({
      message: req.message,
      // The MCP SDK validates requestedSchema as a JSON Schema with
      // `type: "object"` and `properties`. For approval-only elicitations
      // where no fields are needed, provide a minimal valid schema.
      requestedSchema:
        Object.keys(req.requestedSchema).length === 0
          ? { type: "object" as const, properties: {} }
          : req.requestedSchema,
    })),
    Match.exhaustive,
  );

const makeMcpElicitationHandler =
  (
    server: McpServer,
    debugLog?: (event: string, data: Record<string, unknown>) => void,
  ): ElicitationHandler =>
  (ctx: ElicitationContext): Effect.Effect<typeof ElicitationResponse.Type> => {
    const { url: supportsUrl } = getElicitationSupport(server);

    // If client doesn't support url mode, fall back to a form asking the user
    // to visit the URL manually and confirm when done.
    const params = Match.value(ctx.request).pipe(
      Match.tag(
        "UrlElicitation",
        (req): ElicitInputParams =>
          !supportsUrl
            ? {
                message: `${req.message}\n\nPlease visit this URL:\n${req.url}\n\nClick accept once you have completed the flow.`,
                requestedSchema: { type: "object" as const, properties: {} },
              }
            : elicitationRequestToParams(req),
      ),
      Match.tag("FormElicitation", (req): ElicitInputParams => elicitationRequestToParams(req)),
      Match.exhaustive,
    );

    return Effect.promise(async (): Promise<typeof ElicitationResponse.Type> => {
      const requestTag = elicitationRequestTag(ctx.request);
      debugLog?.("elicitation.request", {
        requestTag,
        supportsUrl,
        message: ctx.request.message,
        hasRequestedSchema: requestedSchemaIsNonEmpty(ctx.request),
        url: elicitationRequestUrl(ctx.request),
        clientCapabilities: server.server.getClientCapabilities() ?? null,
      });

      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: MCP SDK elicitInput is a Promise API; failures become a cancel response
      try {
        const response = await server.server.elicitInput(
          params as Parameters<typeof server.server.elicitInput>[0],
        );

        debugLog?.("elicitation.response", {
          requestTag,
          action: response.action,
          hasContent:
            typeof response.content === "object" &&
            response.content !== null &&
            Object.keys(response.content).length > 0,
        });

        return {
          action: response.action as typeof ElicitationResponse.Type.action,
          content: response.content,
        };
      } catch (err) {
        const error = formatBoundaryError(err);
        debugLog?.("elicitation.error", {
          requestTag,
          error,
          clientCapabilities: server.server.getClientCapabilities() ?? null,
        });
        console.error(
          "[executor] elicitInput failed - falling back to cancel.",
          JSON.stringify({
            error,
            requestTag,
            ...capabilitySnapshot(server),
          }),
        );
        return { action: "cancel" as const } as ElicitationResponse;
      }
    });
  };

const formatBoundaryError = (err: unknown): { name?: string; message: string; stack?: string } => {
  // oxlint-disable-next-line executor/no-instanceof-error, executor/no-unknown-error-message -- boundary: SDK Promise rejection supplies unknown JS errors for logging only
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  // oxlint-disable-next-line executor/no-unknown-error-message -- boundary: fallback log formatting for unknown SDK Promise rejection values
  return { message: String(err) };
};

// ---------------------------------------------------------------------------
// MCP result formatting
// ---------------------------------------------------------------------------

type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const toMcpResult = (formatted: ReturnType<typeof formatExecuteResult>): McpToolResult => ({
  content: [{ type: "text", text: formatted.text }],
  structuredContent: formatted.structured,
  isError: formatted.isError || undefined,
});

const toMcpPausedResult = (formatted: ReturnType<typeof formatPausedExecution>): McpToolResult => ({
  content: [{ type: "text", text: formatted.text }],
  structuredContent: formatted.structured,
});

const formatFailureMessage = (value: unknown): string | null => {
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (typeof value === "string" && value.length > 0) return value;
  return null;
};

const toMcpFailureResult = (cause: Cause.Cause<unknown>): McpToolResult => {
  const failure = cause.reasons.find(Cause.isFailReason);
  const text = failure
    ? (formatFailureMessage(failure.error) ?? "Tool execution failed")
    : "Tool execution failed";
  return {
    content: [{ type: "text", text: `Error: ${text}` }],
    structuredContent: { status: "error", error: text },
    isError: true,
  };
};

const toMcpRenderUiRejectedResult = (reason: string): McpToolResult => ({
  content: [{ type: "text", text: `Render UI rejected: ${reason}` }],
  structuredContent: { status: "error", error: reason },
  isError: true,
});

const JsonObjectFromString = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeJsonObjectString = Schema.decodeUnknownOption(JsonObjectFromString);

const parseJsonContent = (raw: string): Record<string, unknown> | undefined => {
  if (raw === "{}") return undefined;
  const parsed = decodeJsonObjectString(raw);
  return Option.isSome(parsed) ? parsed.value : undefined;
};

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export const createExecutorMcpServer = <E extends Cause.YieldableError>(
  config: ExecutorMcpServerConfig<E>,
): Effect.Effect<McpServer> =>
  Effect.gen(function* () {
    const engine = "engine" in config ? config.engine : createExecutionEngine(config);
    const description =
      config.description ??
      (yield* engine.getDescription.pipe(Effect.withSpan("mcp.host.get_description")));
    const executeDescription = stripGenerativeUiSection(description);
    const renderUiDescription = buildRenderUiDescription(description);

    // Captured at construction time. SDK callbacks fire later (often
    // deferred past the outer Effect's await), so we use the runtime to
    // re-enter Effect-land at each callback edge.
    const context = yield* Effect.context<never>();
    const debugEnabled = config.debug ?? readDebugDefault();
    const debugLog = (event: string, data: Record<string, unknown>) => {
      if (!debugEnabled) return;
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: debug logging must tolerate non-serializable SDK capability snapshots
      try {
        console.error(`[executor:mcp] ${event} ${JSON.stringify(data)}`);
      } catch {
        console.error(`[executor:mcp] ${event}`, data);
      }
    };

    const resolveParentSpan = (): Tracer.AnySpan | undefined => {
      const ps = config.parentSpan;
      return typeof ps === "function" ? ps() : ps;
    };
    const anchor = <A, EffE>(effect: Effect.Effect<A, EffE>): Effect.Effect<A, EffE> => {
      const parent = resolveParentSpan();
      return parent ? Effect.withParentSpan(effect, parent) : effect;
    };
    const runToolEffect = <EffE>(effect: Effect.Effect<McpToolResult, EffE>) =>
      Effect.runPromiseWith(context)(
        anchor(effect).pipe(
          Effect.catchCause((cause) => Effect.succeed(toMcpFailureResult(cause))),
        ),
      );

    const server = yield* Effect.sync(
      () =>
        new McpServer(
          { name: "executor", version: "1.0.0" },
          {
            capabilities: { resources: {}, tools: {} },
            jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
          },
        ),
    ).pipe(Effect.withSpan("mcp.host.create_server"));

    const executeCode = (code: string): Effect.Effect<McpToolResult, E> =>
      Effect.gen(function* () {
        debugLog("execute.call", {
          managedElicitation: supportsManagedElicitation(server),
          elicitationSupport: getElicitationSupport(server),
          clientCapabilities: server.server.getClientCapabilities() ?? null,
          codeLength: code.length,
        });
        if (supportsManagedElicitation(server)) {
          const result = yield* engine.execute(code, {
            onElicitation: makeMcpElicitationHandler(server, debugLog),
          });
          return toMcpResult(formatExecuteResult(result));
        }
        const outcome = yield* engine.executeWithPause(code);
        debugLog("execute.paused_flow_result", {
          status: outcome.status,
          executionId: outcome.status === "paused" ? outcome.execution.id : undefined,
          interactionKind:
            outcome.status === "paused"
              ? pausedInteractionKind(outcome.execution.elicitationContext.request)
              : undefined,
        });
        return outcome.status === "completed"
          ? toMcpResult(formatExecuteResult(outcome.result))
          : toMcpPausedResult(formatPausedExecution(outcome.execution));
      }).pipe(
        Effect.withSpan("mcp.host.tool.execute", {
          attributes: {
            "mcp.tool.name": "execute",
            "mcp.execute.code_length": code.length,
          },
        }),
      );

    const resumeExecution = (
      executionId: string,
      action: "accept" | "decline" | "cancel",
      content: Record<string, unknown> | undefined,
    ): Effect.Effect<McpToolResult, E> =>
      Effect.gen(function* () {
        debugLog("resume.call", {
          executionId,
          action,
          hasContent: content !== undefined,
          clientCapabilities: server.server.getClientCapabilities() ?? null,
        });
        const outcome = yield* engine.resume(executionId, { action, content });
        if (!outcome) {
          debugLog("resume.missing_execution", { executionId });
          return {
            content: [{ type: "text" as const, text: `No paused execution: ${executionId}` }],
            isError: true,
          } satisfies McpToolResult;
        }
        debugLog("resume.result", {
          executionId,
          status: outcome.status,
          nextExecutionId: outcome.status === "paused" ? outcome.execution.id : undefined,
          interactionKind:
            outcome.status === "paused"
              ? pausedInteractionKind(outcome.execution.elicitationContext.request)
              : undefined,
        });
        return outcome.status === "completed"
          ? toMcpResult(formatExecuteResult(outcome.result))
          : toMcpPausedResult(formatPausedExecution(outcome.execution));
      }).pipe(
        Effect.withSpan("mcp.host.tool.resume", {
          attributes: {
            "mcp.tool.name": "resume",
            "mcp.execute.resume.action": action,
            "mcp.execute.execution_id": executionId,
          },
        }),
      );

    const executeCodeFromApp = (code: string): Effect.Effect<McpToolResult, E> =>
      Effect.gen(function* () {
        debugLog("execute_action.call", {
          managedElicitation: supportsManagedElicitation(server),
          elicitationSupport: getElicitationSupport(server),
          clientCapabilities: server.server.getClientCapabilities() ?? null,
          codeLength: code.length,
        });

        if (supportsManagedElicitation(server)) {
          const result = yield* engine.execute(code, {
            onElicitation: makeMcpElicitationHandler(server, debugLog),
          });
          return toMcpResult(formatExecuteResult(result));
        }

        const outcome = yield* engine.executeWithPause(code);
        debugLog("execute_action.paused_flow_result", {
          status: outcome.status,
          executionId: outcome.status === "paused" ? outcome.execution.id : undefined,
          interactionKind:
            outcome.status === "paused"
              ? pausedInteractionKind(outcome.execution.elicitationContext.request)
              : undefined,
        });
        return outcome.status === "completed"
          ? toMcpResult(formatExecuteResult(outcome.result))
          : toMcpPausedResult(formatPausedExecution(outcome.execution));
      }).pipe(
        Effect.withSpan("mcp.host.tool.execute_action", {
          attributes: {
            "mcp.tool.name": "execute-action",
            "mcp.execute.code_length": code.length,
          },
        }),
      );

    // --- tools ---

    const executeTool = yield* Effect.sync(() =>
      server.registerTool(
        "execute",
        {
          description: executeDescription,
          inputSchema: { code: z.string().trim().min(1) },
        },
        ({ code }) => runToolEffect(executeCode(code)),
      ),
    ).pipe(
      Effect.withSpan("mcp.host.register_tool", {
        attributes: { "mcp.tool.name": "execute" },
      }),
    );

    const renderUiTool = yield* Effect.sync(() =>
      registerAppTool(
        server,
        "render-ui",
        {
          description: renderUiDescription,
          inputSchema: { code: z.string().trim().min(1) },
          _meta: {
            ui: {
              resourceUri: SHELL_RESOURCE_URI,
              visibility: ["model"],
            },
          },
        },
        ({ code }) => {
          const rejection = validateRenderUiCode(code);
          return Promise.resolve(
            rejection
              ? toMcpRenderUiRejectedResult(rejection)
              : ({
                  content: [{ type: "text" as const, text: "Rendered interactive UI component." }],
                  structuredContent: { code },
                } satisfies McpToolResult),
          );
        },
      ),
    ).pipe(
      Effect.withSpan("mcp.host.register_tool", {
        attributes: { "mcp.tool.name": "render-ui" },
      }),
    );

    const resumeTool = yield* Effect.sync(() =>
      server.registerTool(
        "resume",
        {
          description: [
            "Resume a paused execution using the executionId returned by execute.",
            "Never call this without user approval unless they explicitly state otherwise.",
          ].join("\n"),
          inputSchema: {
            executionId: z.string().describe("The execution ID from the paused result"),
            action: z
              .enum(["accept", "decline", "cancel"])
              .describe("How to respond to the interaction"),
            content: z
              .string()
              .describe("Optional JSON-encoded response content for form elicitations")
              .default("{}"),
          },
        },
        ({ executionId, action, content: rawContent }) =>
          runToolEffect(resumeExecution(executionId, action, parseJsonContent(rawContent))),
      ),
    ).pipe(
      Effect.withSpan("mcp.host.register_tool", {
        attributes: { "mcp.tool.name": "resume" },
      }),
    );

    const executeActionTool = yield* Effect.sync(() =>
      registerAppTool(
        server,
        "execute-action",
        {
          description:
            "Execute code from the UI shell. Used by interactive components to call tools and run mutations.",
          inputSchema: { code: z.string().trim().min(1) },
          _meta: {
            ui: {
              resourceUri: SHELL_RESOURCE_URI,
              visibility: ["app"],
            },
          },
        },
        ({ code }) => runToolEffect(executeCodeFromApp(code)),
      ),
    ).pipe(
      Effect.withSpan("mcp.host.register_tool", {
        attributes: { "mcp.tool.name": "execute-action" },
      }),
    );

    const executeActionResumeTool = yield* Effect.sync(() =>
      registerAppTool(
        server,
        "execute-action-resume",
        {
          description: "Resume an interactive UI action after shell-owned user approval.",
          inputSchema: {
            executionId: z.string().describe("The execution ID from the paused UI action"),
            action: z
              .enum(["accept", "decline", "cancel"])
              .describe("How to respond to the interaction"),
            content: z
              .string()
              .describe("Optional JSON-encoded response content for form elicitations")
              .default("{}"),
          },
          _meta: {
            ui: {
              resourceUri: SHELL_RESOURCE_URI,
              visibility: ["app"],
            },
          },
        },
        ({ executionId, action, content: rawContent }) =>
          runToolEffect(resumeExecution(executionId, action, parseJsonContent(rawContent))),
      ),
    ).pipe(
      Effect.withSpan("mcp.host.register_tool", {
        attributes: { "mcp.tool.name": "execute-action-resume" },
      }),
    );

    yield* Effect.sync(() =>
      registerAppResource(
        server,
        "Executor Shell",
        SHELL_RESOURCE_URI,
        { mimeType: RESOURCE_MIME_TYPE },
        async () => {
          const html = await loadShellHtml();
          return {
            contents: [{ uri: SHELL_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
          };
        },
      ),
    ).pipe(
      Effect.withSpan("mcp.host.register_resource", {
        attributes: { "mcp.resource.uri": SHELL_RESOURCE_URI },
      }),
    );

    // --- capability-based tool visibility ---

    const syncToolAvailability = () => {
      executeTool.enable();
      if (supportsManagedElicitation(server)) {
        resumeTool.disable();
      } else {
        resumeTool.enable();
      }
      const capabilities = server.server.getClientCapabilities() as
        | McpAppsClientCapabilities
        | undefined;
      const uiCap = getUiCapability(capabilities);
      const appsEnabled = Boolean(uiCap?.mimeTypes?.includes(RESOURCE_MIME_TYPE));
      if (appsEnabled) {
        renderUiTool.enable();
        executeActionTool.enable();
        executeActionResumeTool.enable();
      } else {
        renderUiTool.disable();
        executeActionTool.disable();
        executeActionResumeTool.disable();
      }
      console.error(
        "[executor] MCP capability snapshot",
        JSON.stringify({
          ...capabilitySnapshot(server),
          appsSupport: uiCap ?? null,
          renderUiEnabled: appsEnabled,
          executeActionEnabled: appsEnabled,
          resumeEnabled: !supportsManagedElicitation(server),
        }),
      );
      debugLog("tool.visibility", {
        clientCapabilities: server.server.getClientCapabilities() ?? null,
        elicitationSupport: getElicitationSupport(server),
        managedElicitation: supportsManagedElicitation(server),
        appsSupport: uiCap ?? null,
        renderUiEnabled: appsEnabled,
        executeActionEnabled: appsEnabled,
        resumeEnabled: !supportsManagedElicitation(server),
      });
    };

    yield* Effect.sync(() => {
      syncToolAvailability();
      server.server.oninitialized = syncToolAvailability;
    }).pipe(Effect.withSpan("mcp.host.sync_tool_availability"));

    return server;
  }).pipe(Effect.withSpan("mcp.host.create_executor_server"));

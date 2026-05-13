import { Effect } from "effect";
import {
  getUiCapability,
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";

import {
  defineMcpContribution,
  type McpPluginContribution,
  type McpPluginRegisterContext,
  type McpToolResult,
} from "./plugin";

type ToggleableMcpRegistration = {
  enable: () => void;
  disable: () => void;
};

type McpAppsClientCapabilities = ClientCapabilities & {
  readonly extensions?: Record<string, unknown>;
};

export const DYNAMIC_UI_SHELL_RESOURCE_URI = "ui://executor/shell.html";

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

export const availableNamespacesSection = (description: string): string | undefined => {
  const start = sectionStart(description, "## Available namespaces");
  return start >= 0 ? description.slice(start).trim() : undefined;
};

export const stripGenerativeUiSection = (description: string): string => {
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

export const buildRenderUiDescription = (executeDescription: string): string => {
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

export const validateRenderUiCode = (code: string): string | null => {
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

const toMcpRenderUiRejectedResult = (reason: string): McpToolResult => ({
  content: [{ type: "text", text: `Render UI rejected: ${reason}` }],
  structuredContent: { status: "error", error: reason },
  isError: true,
});

export const dynamicUiMcpContribution = (): McpPluginContribution => {
  let renderUiTool: ToggleableMcpRegistration | undefined;
  let executeActionTool: ToggleableMcpRegistration | undefined;
  let executeActionResumeTool: ToggleableMcpRegistration | undefined;

  return defineMcpContribution({
    id: "dynamic-ui",
    register: (ctx: McpPluginRegisterContext) =>
      Effect.sync(() => {
        renderUiTool = registerAppTool(
          ctx.server,
          "render-ui",
          {
            description: buildRenderUiDescription(ctx.description),
            inputSchema: { code: z.string().trim().min(1) },
            _meta: {
              ui: {
                resourceUri: DYNAMIC_UI_SHELL_RESOURCE_URI,
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
                    content: [
                      { type: "text" as const, text: "Rendered interactive UI component." },
                    ],
                    structuredContent: { code },
                  } satisfies McpToolResult),
            );
          },
        );

        executeActionTool = registerAppTool(
          ctx.server,
          "execute-action",
          {
            description:
              "Execute code from the UI shell. Used by interactive components to call tools and run mutations.",
            inputSchema: { code: z.string().trim().min(1) },
            _meta: {
              ui: {
                resourceUri: DYNAMIC_UI_SHELL_RESOURCE_URI,
                visibility: ["app"],
              },
            },
          },
          ({ code }) => ctx.runToolEffect(ctx.executeCodeFromApp(code)),
        );

        executeActionResumeTool = registerAppTool(
          ctx.server,
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
                resourceUri: DYNAMIC_UI_SHELL_RESOURCE_URI,
                visibility: ["app"],
              },
            },
          },
          ({ executionId, action, content: rawContent }) =>
            ctx.runToolEffect(
              ctx.resumeExecution(executionId, action, ctx.parseJsonContent(rawContent)),
            ),
        );

        registerAppResource(
          ctx.server,
          "Executor Shell",
          DYNAMIC_UI_SHELL_RESOURCE_URI,
          { mimeType: RESOURCE_MIME_TYPE },
          async () => {
            const html = await loadShellHtml();
            return {
              contents: [
                {
                  uri: DYNAMIC_UI_SHELL_RESOURCE_URI,
                  mimeType: RESOURCE_MIME_TYPE,
                  text: html,
                  _meta: {
                    ui: {
                      csp: {
                        connectDomains: [],
                        resourceDomains: [],
                      },
                    },
                  },
                },
              ],
            };
          },
        );
      }).pipe(Effect.withSpan("mcp.host.dynamic_ui.register")),
    onClientCapabilitiesChanged: ({ clientCapabilities, debugLog }) => {
      const uiCap = getUiCapability(clientCapabilities as McpAppsClientCapabilities | undefined);
      const appsEnabled = Boolean(uiCap?.mimeTypes?.includes(RESOURCE_MIME_TYPE));

      if (appsEnabled) {
        renderUiTool?.enable();
        executeActionTool?.enable();
        executeActionResumeTool?.enable();
      } else {
        renderUiTool?.disable();
        executeActionTool?.disable();
        executeActionResumeTool?.disable();
      }

      debugLog("dynamic_ui.visibility", {
        appsSupport: uiCap ?? null,
        renderUiEnabled: appsEnabled,
        executeActionEnabled: appsEnabled,
      });
    },
  });
};

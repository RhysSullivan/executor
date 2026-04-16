import { Effect } from "effect";
import type { Executor, ToolMetadata, Source } from "@executor/sdk";

/**
 * Builds a tool description dynamically.
 *
 * Structure:
 *   1. Workflow (top — critical, least likely to be truncated)
 *   2. Available namespaces (bottom)
 */
export const buildExecuteDescription = (executor: Executor): Effect.Effect<string> =>
  Effect.gen(function* () {
    const sources: readonly Source[] = yield* executor.sources.list();
    const tools: readonly ToolMetadata[] = yield* executor.tools.list();

    const namespaces = new Set<string>();
    for (const tool of tools) namespaces.add(tool.sourceId);

    return formatDescription([...namespaces], sources);
  });

const formatDescription = (namespaces: readonly string[], sources: readonly Source[]): string => {
  const lines: string[] = [
    "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
    "",
    "## Workflow",
    "",
    '1. `const matches = await tools.search({ query: "<intent + key nouns>", limit: 12 });`',
    '2. `const path = matches[0]?.path; if (!path) return "No matching tools found.";`',
    "3. `const details = await tools.describe.tool({ path });`",
    "4. Use `details.inputTypeScript` / `details.outputTypeScript` and `details.typeScriptDefinitions` for compact shapes.",
    "5. Use `tools.executor.sources.list()` when you need configured source inventory.",
    "6. Call the tool: `const result = await tools.<path>(input);`",
    "",
    "## Rules",
    "",
    "- `tools.search()` returns ranked matches, best-first. Use short intent phrases like `github issues`, `repo details`, or `create calendar event`.",
    '- When you already know the namespace, narrow with `tools.search({ namespace: "github", query: "issues" })`.',
    "- Use `tools.executor.sources.list()` to inspect configured sources and their tool counts. Returns `[{ id, toolCount, ... }]`.",
    "- Always use the namespace prefix when calling tools: `tools.<namespace>.<tool>(args)`. Example: `tools.home_assistant_rest_api.states.getState(...)` — not `tools.states.getState(...)`.",
    "- The `tools` object is a lazy proxy — `Object.keys(tools)` won't work. Use `tools.search()` or `tools.executor.sources.list()` instead.",
    '- Pass an object to system tools, e.g. `tools.search({ query: "..." })`, `tools.executor.sources.list()`, and `tools.describe.tool({ path })`.',
    "- `tools.describe.tool()` returns compact TypeScript shapes. Use `inputTypeScript`, `outputTypeScript`, and `typeScriptDefinitions`.",
    "- For tools that return large collections (e.g. `getStates`, `getAll`), filter results in code rather than calling per-item tools.",
    "- Do not use `fetch` — all API calls go through `tools.*`.",
    "- If execution pauses for interaction, resume it with the returned `resumePayload`.",
    "",
    "## Generative UI",
    "",
    "When it would be helpful to show an interactive UI, write a React component named `App` with JSX in the `code` parameter. It renders in an iframe alongside the conversation.",
    "",
    "**No imports** — everything is already in scope:",
    "- React: `useState`, `useEffect`, `useRef`, `useCallback`, `useMemo`",
    "- Data fetching: `useQuery(fn)` → `{ data, error, isLoading, refetch }`, `useMutation(fn)` → `{ mutate, data, error, isPending }`",
    "- Tools: `tools.<namespace>.<tool>(args)` — call any configured API tool (never use raw `fetch`)",
    "- Components (shadcn/ui): Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Button, Input, Textarea, Label, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, Checkbox, Switch, Slider, Toggle, Tabs, TabsList, TabsTrigger, TabsContent, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Badge, Avatar, AvatarFallback, Alert, AlertTitle, AlertDescription, Dialog, Sheet, Popover, Tooltip, Separator, ScrollArea, Skeleton, Progress, Accordion, AccordionItem, AccordionTrigger, AccordionContent, DropdownMenu + sub-components",
    "- Charts (Recharts): BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Legend, ChartContainer, ChartTooltip, ChartTooltipContent",
    "- Icons (Lucide): Plus, Minus, Check, X, Search, Loader2, AlertCircle, ExternalLink, Copy, Trash2, Edit, Settings, User, Globe, Star, TrendingUp, Activity, Database, Shield, Package, and more",
    "- Utility: `cn()` for className merging, `run(code)` escape hatch for multi-step tool composition",
    "- Use Tailwind classes for styling. The UI must look good in both light and dark mode — the user's system theme is applied automatically.",
    "- Always use `dark:` variants when applying custom colors: e.g. `bg-white dark:bg-gray-900`, `text-gray-900 dark:text-gray-100`. Or prefer theme variables that adapt automatically: `bg-background`, `text-foreground`, `bg-card`, `text-card-foreground`, `bg-muted`, `text-muted-foreground`, `bg-primary`, `text-primary-foreground`, `bg-secondary`, `text-secondary-foreground`, `bg-accent`, `text-accent-foreground`, `bg-destructive`, `border-border`, `ring-ring`.",
    "- Never use hardcoded colors without a `dark:` counterpart — e.g. `bg-gray-50` alone will look wrong in dark mode.",
    "- The UI container defaults to `maxHeight: 800` (pixels). Override by declaring `const config = { maxHeight: 400 }` for small widgets or `const config = { maxHeight: 1000 }` for large lists/tables.",
  ];

  if (namespaces.length > 0) {
    lines.push("");
    lines.push("## Available namespaces");
    lines.push("");
    const sorted = [...namespaces].sort();
    for (const ns of sorted) {
      const source = sources.find((s) => s.id === ns);
      const label = source?.name ?? ns;
      lines.push(`- \`${ns}\`${label !== ns ? ` — ${label}` : ""}`);
    }
  }

  return lines.join("\n");
};

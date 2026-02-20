"use client";

import { useMemo } from "react";
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import { ShieldCheck, Zap } from "lucide-react";
import type { ToolDescriptor } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { traverseSchema, type SchemaFieldEntry } from "@/lib/tool/schema-traverse";
import { TypeSignature } from "./type-signature";
import { CopyButton } from "./copy-button";

const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseSchemaJson(value: string): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    return {};
  }
}

// ── Type color mapping ──────────────────────────────────────────────────────

function typeColorClasses(type: string): string {
  switch (type) {
    case "string":
      return "text-[oklch(0.45_0.14_155)] bg-[oklch(0.45_0.14_155_/_0.07)] border-[oklch(0.45_0.14_155_/_0.15)] dark:text-[oklch(0.75_0.14_155)] dark:bg-[oklch(0.75_0.14_155_/_0.1)] dark:border-[oklch(0.75_0.14_155_/_0.2)]";
    case "number":
    case "integer":
      return "text-[oklch(0.50_0.16_260)] bg-[oklch(0.50_0.16_260_/_0.07)] border-[oklch(0.50_0.16_260_/_0.15)] dark:text-[oklch(0.75_0.14_260)] dark:bg-[oklch(0.75_0.14_260_/_0.1)] dark:border-[oklch(0.75_0.14_260_/_0.2)]";
    case "boolean":
      return "text-[oklch(0.55_0.18_300)] bg-[oklch(0.55_0.18_300_/_0.07)] border-[oklch(0.55_0.18_300_/_0.15)] dark:text-[oklch(0.78_0.14_300)] dark:bg-[oklch(0.78_0.14_300_/_0.1)] dark:border-[oklch(0.78_0.14_300_/_0.2)]";
    case "array":
      return "text-[oklch(0.50_0.14_200)] bg-[oklch(0.50_0.14_200_/_0.07)] border-[oklch(0.50_0.14_200_/_0.15)] dark:text-[oklch(0.75_0.12_200)] dark:bg-[oklch(0.75_0.12_200_/_0.1)] dark:border-[oklch(0.75_0.12_200_/_0.2)]";
    case "object":
      return "text-[oklch(0.55_0.12_75)] bg-[oklch(0.55_0.12_75_/_0.07)] border-[oklch(0.55_0.12_75_/_0.15)] dark:text-[oklch(0.78_0.1_75)] dark:bg-[oklch(0.78_0.1_75_/_0.1)] dark:border-[oklch(0.78_0.1_75_/_0.2)]";
    case "enum":
    case "union":
      return "text-[oklch(0.50_0.16_30)] bg-[oklch(0.50_0.16_30_/_0.07)] border-[oklch(0.50_0.16_30_/_0.15)] dark:text-[oklch(0.75_0.14_30)] dark:bg-[oklch(0.75_0.14_30_/_0.1)] dark:border-[oklch(0.75_0.14_30_/_0.2)]";
    case "null":
      return "text-muted-foreground/70";
    default:
      return "text-muted-foreground/50";
  }
}

// ── Constraint badges ───────────────────────────────────────────────────────

function ConstraintBadges({ entry }: { entry: SchemaFieldEntry }) {
  const parts: string[] = [];

  if (entry.constraints) {
    const c = entry.constraints;
    if (c.minimum !== undefined) parts.push(`>= ${c.minimum}`);
    if (c.maximum !== undefined) parts.push(`<= ${c.maximum}`);
    if (c.exclusiveMinimum !== undefined) parts.push(`> ${c.exclusiveMinimum}`);
    if (c.exclusiveMaximum !== undefined) parts.push(`< ${c.exclusiveMaximum}`);
    if (c.minLength !== undefined) parts.push(`minLen: ${c.minLength}`);
    if (c.maxLength !== undefined) parts.push(`maxLen: ${c.maxLength}`);
    if (c.pattern) parts.push(`/${c.pattern}/`);
    if (c.minItems !== undefined) parts.push(`minItems: ${c.minItems}`);
    if (c.maxItems !== undefined) parts.push(`maxItems: ${c.maxItems}`);
    if (c.uniqueItems) parts.push("unique");
  }

  if (entry.format && !entry.typeLabel.includes(entry.format)) {
    parts.push(entry.format);
  }

  if (parts.length === 0) return null;

  return (
    <span className="inline-flex items-center gap-1 ml-0.5">
      {parts.map((p, i) => (
        <span key={i} className="rounded-sm bg-muted px-1 text-[11px] leading-[1.4] text-muted-foreground/70">
          {p}
        </span>
      ))}
    </span>
  );
}

// ── Field row ───────────────────────────────────────────────────────────────

function FieldRow({ entry }: { entry: SchemaFieldEntry }) {
  return (
    <div
      className="flex flex-col gap-1 py-2.5 pr-3.5 border-b border-border/50 last:border-b-0"
      style={{ paddingLeft: `${entry.depth * 16 + 14}px` }}
    >
      {/* Name + type line */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-sm font-semibold leading-tight text-foreground">
          {entry.path.split(".").pop()}
        </span>

        {entry.required ? (
          <span
            className="w-1 h-1 rounded-full bg-[oklch(0.65_0.22_25)] dark:bg-[oklch(0.72_0.2_25)] shrink-0"
            title="required"
          />
        ) : null}

        <span
          className={cn(
            "rounded-[3px] border px-1.5 py-0.5 text-[11px] leading-none font-medium",
            typeColorClasses(entry.type),
          )}
        >
          {entry.typeLabel}
        </span>

        {entry.deprecated ? (
          <span className="rounded-[3px] border border-[oklch(0.6_0.16_75_/_0.18)] bg-[oklch(0.6_0.16_75_/_0.08)] px-1.5 py-px text-[10px] font-medium leading-none text-[oklch(0.6_0.16_75)] dark:border-[oklch(0.78_0.14_75_/_0.2)] dark:bg-[oklch(0.78_0.14_75_/_0.1)] dark:text-[oklch(0.78_0.14_75)]">
            deprecated
          </span>
        ) : null}

        <ConstraintBadges entry={entry} />
      </div>

      {/* Description */}
      {entry.description ? (
        <div className="text-xs leading-relaxed text-muted-foreground [&_p]:m-0 [&_p+p]:mt-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_code]:bg-muted [&_code]:border [&_code]:border-border/70 [&_code]:rounded-sm [&_code]:px-1 [&_code]:py-px [&_code]:text-primary [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a]:decoration-primary/25 hover:[&_a]:decoration-primary/70">
          <Streamdown plugins={{ code: codePlugin }} controls={false}>{entry.description}</Streamdown>
        </div>
      ) : null}

      {/* Enum values */}
      {entry.enumValues && entry.enumValues.length > 0 && entry.enumValues.length <= 12 ? (
        <div className="flex flex-wrap gap-1 mt-0.5">
          {entry.enumValues.map((v, i) => (
            <code key={i} className="rounded-[3px] border border-border/60 bg-muted px-1.5 py-px font-mono text-[11px] text-foreground/80">
              {v}
            </code>
          ))}
        </div>
      ) : null}

      {/* Example / Default */}
      {(entry.example || entry.defaultValue) ? (
        <div className="flex flex-wrap gap-2 mt-0.5">
          {entry.example ? (
            <span className="inline-flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground/60">Example</span>
              <code className="font-mono text-xs text-muted-foreground/85">{entry.example}</code>
            </span>
          ) : null}
          {entry.defaultValue ? (
            <span className="inline-flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground/60">Default</span>
              <code className="font-mono text-xs text-muted-foreground/85">{entry.defaultValue}</code>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Schema fields section ───────────────────────────────────────────────────

/** Detect schemas that describe an empty / void result (no useful fields). */
function isEmptySchema(schemaJson: string | undefined): boolean {
  if (!schemaJson) return false;
  try {
    const parsed = JSON.parse(schemaJson) as Record<string, unknown>;
    if (parsed.type === "object") {
      const props = parsed.properties;
      if (!props || (typeof props === "object" && Object.keys(props as object).length === 0)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function SchemaFieldsSection({
  label,
  entries,
  truncated,
  schemaJson,
}: {
  label: string;
  entries: SchemaFieldEntry[];
  truncated: boolean;
  schemaJson?: string;
}) {
  if (entries.length === 0 && !schemaJson) return null;

  const hasEntries = entries.length > 0;
  const empty = !hasEntries && isEmptySchema(schemaJson);
  const collapsedByDefault = entries.length > 10 || truncated;

  return (
    <div className="flex flex-col gap-2">
      {/* Section header */}
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-muted-foreground/70">
          {label}
        </span>
        {hasEntries ? (
          <span className="text-xs text-muted-foreground/60">
            {entries.length} field{entries.length !== 1 ? "s" : ""}
            {truncated ? "+" : ""}
          </span>
        ) : null}
      </div>

      {/* Field list */}
      {hasEntries ? (
        <div className="border border-border rounded-md bg-muted/30 overflow-hidden">
          {collapsedByDefault ? (
            <details open={false}>
              <summary className="block cursor-pointer select-none px-3.5 py-2 text-xs text-muted-foreground/70 transition-opacity hover:opacity-100">
                Show all fields ({entries.length}{truncated ? "+" : ""})
              </summary>
              <div className="flex flex-col">
                {entries.map((entry, i) => (
                  <FieldRow key={`${entry.path}-${i}`} entry={entry} />
                ))}
                {truncated ? (
                  <p className="px-3.5 py-2 text-xs text-muted-foreground/60">
                    Showing first {entries.length} fields...
                  </p>
                ) : null}
              </div>
            </details>
          ) : (
            <div className="flex flex-col">
              {entries.map((entry, i) => (
                <FieldRow key={`${entry.path}-${i}`} entry={entry} />
              ))}
            </div>
          )}
        </div>
      ) : empty ? (
        <p className="pl-0.5 text-xs italic text-muted-foreground/60">
          Empty object
        </p>
      ) : schemaJson ? (
        <TypeSignature raw={schemaJson} label="" lang="json" />
      ) : null}

      {/* Raw schema toggle */}
      {hasEntries && schemaJson ? (
        <details className="mt-1">
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground/60 transition-opacity hover:opacity-80">
            Raw schema
          </summary>
          <div className="mt-1.5">
            <TypeSignature raw={schemaJson} label="" lang="json" />
          </div>
        </details>
      ) : null}
    </div>
  );
}

// ── Inline detail (used inside collapsible rows in tree/flat view) ───────────

export function ToolDetail({
  tool,
  depth,
  loading,
}: {
  tool: ToolDescriptor;
  depth: number;
  loading?: boolean;
}) {
  const insetLeft = depth * 20 + 8 + 16 + 8;

  return (
    <div style={{ paddingLeft: insetLeft }}>
      <ToolDetailContent tool={tool} loading={loading} />
    </div>
  );
}

// ── Standalone detail panel (main content area in sidebar layout) ────────────

export function ToolDetailPanel({
  tool,
  loading,
}: {
  tool: ToolDescriptor;
  loading?: boolean;
}) {
  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border/40 px-5 py-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Zap className="h-3.5 w-3.5 text-primary/70 shrink-0" />
          <h2 className="truncate text-sm font-semibold text-foreground">
            {tool.path}
          </h2>
          {tool.approval === "required" ? (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-terminal-amber/15 bg-terminal-amber/8 px-1.5 py-0.5 text-xs font-medium text-terminal-amber">
              <ShieldCheck className="h-2.5 w-2.5" />
              gated
            </span>
          ) : null}
          <div className="ml-auto shrink-0">
            <CopyButton text={tool.path} />
          </div>
        </div>
        {tool.source ? (
          <p className="mt-0.5 pl-6 text-xs text-muted-foreground/60">
            {tool.source}
          </p>
        ) : null}
      </div>

      {/* Body */}
      <div className="px-5 py-4">
        <ToolDetailContent tool={tool} loading={loading} />
      </div>
    </div>
  );
}

// ── Empty state for detail panel ────────────────────────────────────────────

export function ToolDetailEmpty() {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center space-y-2">
        <div className="h-10 w-10 rounded-full bg-muted/40 flex items-center justify-center mx-auto">
          <Zap className="h-5 w-5 text-muted-foreground/20" />
        </div>
        <p className="text-[13px] text-muted-foreground/50">
          Select a tool to view its schema
        </p>
      </div>
    </div>
  );
}

// ── Shared detail content (used by both inline and panel modes) ─────────────

function ToolDetailContent({
  tool,
  loading,
}: {
  tool: ToolDescriptor;
  loading?: boolean;
}) {
  const description = tool.description?.trim() ?? "";
  const inputHint = tool.display?.input?.trim() ?? "";
  const outputHint = tool.display?.output?.trim() ?? "";
  const inputSchemaJson = tool.typing?.inputSchemaJson?.trim() ?? "";
  const outputSchemaJson = tool.typing?.outputSchemaJson?.trim() ?? "";
  const hasInputHint = inputHint.length > 0 && inputHint !== "{}" && inputHint.toLowerCase() !== "unknown";
  const hasOutputHint = outputHint.length > 0 && outputHint.toLowerCase() !== "unknown";
  const hasInputSchema = inputSchemaJson.length > 0 && inputSchemaJson !== "{}";
  const hasOutputSchema = outputSchemaJson.length > 0 && outputSchemaJson !== "{}";

  const inputFields = useMemo(
    () => traverseSchema(parseSchemaJson(inputSchemaJson), { maxEntries: 30, maxDepth: 5 }),
    [inputSchemaJson],
  );
  const outputFields = useMemo(
    () => traverseSchema(parseSchemaJson(outputSchemaJson), { maxEntries: 30, maxDepth: 5 }),
    [outputSchemaJson],
  );

  const hasInputFields = inputFields.entries.length > 0;
  const hasOutputFields = outputFields.entries.length > 0;

  const canRenderInputSchema = hasInputSchema && hasInputFields;
  const canRenderOutputSchema = hasOutputSchema && hasOutputFields;

  const shouldShowInputHint = hasInputHint && !canRenderInputSchema;
  const shouldShowOutputHint = hasOutputHint && !canRenderOutputSchema;

  const hasDetails = description.length > 0
    || shouldShowInputHint
    || shouldShowOutputHint
    || canRenderInputSchema
    || canRenderOutputSchema;
  const showLoading = Boolean(loading);

  return (
    <div className="pt-2 pb-4 flex flex-col gap-4">
      {/* Loading state */}
      {showLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-3.5 w-72" />
          <div>
            <p className="text-xs font-medium text-muted-foreground/70">Arguments</p>
            <Skeleton className="h-20 w-full rounded-md mt-1" />
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground/70">Returns</p>
            <Skeleton className="h-14 w-full rounded-md mt-1" />
          </div>
        </div>
      ) : null}

      {/* Description */}
      {description ? (
        <div className="text-[12px] leading-relaxed text-muted-foreground">
          <Streamdown plugins={{ code: codePlugin }} controls={{ code: true }}>{description}</Streamdown>
        </div>
      ) : null}

      {/* Type hint fallbacks (when no full schema is available) */}
      {shouldShowInputHint ? <TypeSignature raw={inputHint} label="Arguments" /> : null}
      {shouldShowOutputHint ? <TypeSignature raw={outputHint} label="Returns" /> : null}

      {/* Structured schema rendering */}
      {canRenderInputSchema ? (
        <SchemaFieldsSection
          label="Arguments"
          entries={inputFields.entries}
          truncated={inputFields.truncated}
          schemaJson={inputSchemaJson}
        />
      ) : null}

      {canRenderOutputSchema ? (
        <SchemaFieldsSection
          label="Returns"
          entries={outputFields.entries}
          truncated={outputFields.truncated}
          schemaJson={outputSchemaJson}
        />
      ) : null}

      {/* Empty state */}
      {!showLoading && !hasDetails ? (
        <p className="text-[11px] text-muted-foreground/50 italic">
          No description or schema available.
        </p>
      ) : null}
    </div>
  );
}

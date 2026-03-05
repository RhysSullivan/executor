"use client";

import { useMemo } from "react";
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import { cn } from "../../lib/utils";
import {
  traverseSchema,
  type SchemaFieldEntry,
} from "../../lib/tool/schema-traverse";

const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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

// ── Type signature (raw schema code block) ──────────────────────────────────

function prettyJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed, null, 2);
    } catch {
      // fall through
    }
  }

  if (trimmed.includes("\n") || trimmed.length < 50) {
    return trimmed;
  }

  let output = "";
  let indent = 0;
  const tab = "  ";
  let index = 0;

  while (index < trimmed.length) {
    const char = trimmed[index];

    if (char === "[" && trimmed[index + 1] === "]") {
      output += "[]";
      index += 2;
    } else if (char === "{") {
      indent++;
      output += `${char}\n${tab.repeat(indent)}`;
      index++;
      while (index < trimmed.length && trimmed[index] === " ") {
        index++;
      }
    } else if (char === "}") {
      indent = Math.max(0, indent - 1);
      output = output.replace(/\s+$/, "");
      output += `\n${tab.repeat(indent)}${char}`;
      index++;
    } else if (char === ";" && trimmed[index + 1] === " ") {
      output += `;\n${tab.repeat(indent)}`;
      index += 2;
    } else if (char === "," && indent > 0 && trimmed[index + 1] === " ") {
      output += `,\n${tab.repeat(indent)}`;
      index += 2;
    } else {
      output += char;
      index++;
    }
  }

  return output;
}

function TypeSignature({ raw, label }: { raw: string; label: string }) {
  const formatted = useMemo(() => prettyJson(raw), [raw]);

  return (
    <div className="relative group/schema">
      {label ? (
        <p className="mb-1 font-mono text-[9px] font-medium tracking-wider uppercase text-muted-foreground/60">
          {label}
        </p>
      ) : null}
      <pre className="font-mono text-[10.5px] leading-[1.65] bg-muted/40 border border-border/40 rounded-md px-3.5 py-2.5 overflow-x-auto text-foreground/80 whitespace-pre m-0">
        {formatted}
      </pre>
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
        <TypeSignature raw={schemaJson} label="" />
      ) : null}

      {/* Raw schema toggle */}
      {hasEntries && schemaJson ? (
        <details className="mt-1">
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground/60 transition-opacity hover:opacity-80">
            Raw schema
          </summary>
          <div className="mt-1.5">
            <TypeSignature raw={schemaJson} label="" />
          </div>
        </details>
      ) : null}
    </div>
  );
}

// ── Main export: ToolSchemaSection ──────────────────────────────────────────

export function ToolSchemaSection({
  inputSchemaJson,
  outputSchemaJson,
}: {
  inputSchemaJson: string | null;
  outputSchemaJson: string | null;
}) {
  const hasInputSchema = !!inputSchemaJson && inputSchemaJson !== "{}";
  const hasOutputSchema = !!outputSchemaJson && outputSchemaJson !== "{}";

  const inputSchema = useMemo(() => parseSchemaJson(inputSchemaJson ?? ""), [inputSchemaJson]);
  const outputSchema = useMemo(() => parseSchemaJson(outputSchemaJson ?? ""), [outputSchemaJson]);

  const inputFields = useMemo(
    () => hasInputSchema ? traverseSchema(inputSchema, { maxEntries: 30, maxDepth: 5 }) : { entries: [], truncated: false },
    [inputSchema, hasInputSchema],
  );
  const outputFields = useMemo(
    () => hasOutputSchema ? traverseSchema(outputSchema, { maxEntries: 30, maxDepth: 5 }) : { entries: [], truncated: false },
    [outputSchema, hasOutputSchema],
  );

  if (!hasInputSchema && !hasOutputSchema) {
    return null;
  }

  return (
    <>
      {hasInputSchema ? (
        <section>
          <SchemaFieldsSection
            label="Arguments"
            entries={inputFields.entries}
            truncated={inputFields.truncated}
            schemaJson={inputSchemaJson ?? undefined}
          />
        </section>
      ) : null}

      {hasOutputSchema ? (
        <section>
          <SchemaFieldsSection
            label="Returns"
            entries={outputFields.entries}
            truncated={outputFields.truncated}
            schemaJson={outputSchemaJson ?? undefined}
          />
        </section>
      ) : null}
    </>
  );
}

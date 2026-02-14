"use client";

import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import type { ToolDescriptor } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { TypeSignature } from "./type-signature";

const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

function extractSchemaRefTokens(typeExpression: string): string[] {
  const tokens = new Set<string>();
  const pattern = /components\["schemas"\]\["((?:\\.|[^"\\])*)"\]/g;

  for (const match of typeExpression.matchAll(pattern)) {
    const raw = match[1];
    if (!raw) continue;

    let schemaKey = raw;
    try {
      schemaKey = JSON.parse(`"${raw}"`);
    } catch {
      // Preserve original key when escape decoding fails.
    }

    tokens.add(`components["schemas"][${JSON.stringify(schemaKey)}]`);
  }

  return [...tokens];
}

function shouldUseStrictType(displayType?: string): boolean {
  if (!displayType) return false;
  return displayType.includes("...");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inlineSchemaRefs(typeExpression: string, sourceSchemas?: Record<string, string>): string {
  if (!sourceSchemas || Object.keys(sourceSchemas).length === 0) {
    return typeExpression;
  }

  let inlined = typeExpression;
  for (const schemaRef of extractSchemaRefTokens(typeExpression)) {
    const schemaType = sourceSchemas[schemaRef];
    if (!schemaType) continue;
    const pattern = new RegExp(escapeRegExp(schemaRef), "g");
    inlined = inlined.replace(pattern, `(${schemaType})`);
  }

  return inlined;
}

export function ToolDetail({
  tool,
  depth,
  loading: _loading = false,
  sourceSchemas,
}: {
  tool: ToolDescriptor;
  depth: number;
  loading?: boolean;
  sourceSchemas?: Record<string, string>;
}) {
  const insetLeft = depth * 20 + 8 + 16 + 8;
  const displayArgsType = tool.argsType?.trim();
  const displayReturnsType = tool.returnsType?.trim();
  const strictArgsType = tool.strictArgsType?.trim();
  const strictReturnsType = tool.strictReturnsType?.trim();
  const argsType = shouldUseStrictType(displayArgsType)
    ? (strictArgsType || displayArgsType)
    : (displayArgsType || strictArgsType);
  const returnsType = shouldUseStrictType(displayReturnsType)
    ? (strictReturnsType || displayReturnsType)
    : (displayReturnsType || strictReturnsType);
  const resolvedArgsType = argsType ? inlineSchemaRefs(argsType, sourceSchemas) : undefined;
  const resolvedReturnsType = returnsType ? inlineSchemaRefs(returnsType, sourceSchemas) : undefined;
  const schemaTypes = [
    resolvedArgsType,
    resolvedReturnsType,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => extractSchemaRefTokens(value));
  const schemaEntries = [...new Set(schemaTypes)]
    .map((schemaRef) => ({
      schemaRef,
      schemaType: sourceSchemas?.[schemaRef],
    }))
    .filter((entry): entry is { schemaRef: string; schemaType: string } => Boolean(entry.schemaType));
  const hasDetails = Boolean(tool.description || resolvedArgsType || resolvedReturnsType);

  return (
    <div className="space-y-2.5 pb-3 pt-1 pr-2" style={{ paddingLeft: insetLeft }}>
      {!hasDetails ? (
        <div className="space-y-2.5">
          <Skeleton className="h-3.5 w-64" />

          <div>
            <p className="mb-1 text-[9px] font-mono uppercase tracking-wider text-muted-foreground/50">
              Arguments
            </p>
            <Skeleton className="h-16 w-full rounded-md" />
          </div>

          <div>
            <p className="mb-1 text-[9px] font-mono uppercase tracking-wider text-muted-foreground/50">
              Returns
            </p>
            <Skeleton className="h-12 w-full rounded-md" />
          </div>
        </div>
      ) : null}

      {tool.description && (
        <div className="tool-description text-[12px] leading-relaxed text-muted-foreground">
          <Streamdown plugins={{ code: codePlugin }}>{tool.description}</Streamdown>
        </div>
      )}

      {resolvedArgsType && <TypeSignature raw={resolvedArgsType} label="Arguments" />}
      {resolvedReturnsType && <TypeSignature raw={resolvedReturnsType} label="Returns" />}
      {schemaEntries.length > 0 && (
        <div className="space-y-2">
          <p className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground/50">
            Schemas
          </p>
          {schemaEntries.map(({ schemaRef, schemaType }) => (
            <div key={schemaRef} className="space-y-1">
              <p className="text-[10px] font-mono text-muted-foreground break-all">
                {schemaRef}
              </p>
              <pre className="text-[11px] font-mono leading-relaxed text-foreground/80 bg-muted/40 border border-border/40 rounded-md px-2.5 py-2 overflow-x-auto whitespace-pre-wrap break-all">
                {schemaType}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

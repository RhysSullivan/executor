"use client";

import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import type { ToolDescriptor } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { TypeSignature } from "./type-signature";

const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

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
  const description = tool.description?.trim() ?? "";
  const inputHint = tool.display?.input?.trim() ?? "";
  const outputHint = tool.display?.output?.trim() ?? "";
  const inputSchemaJson = tool.typing?.inputSchemaJson?.trim() ?? "";
  const outputSchemaJson = tool.typing?.outputSchemaJson?.trim() ?? "";
  const hasInputHint = inputHint.length > 0 && inputHint !== "{}" && inputHint.toLowerCase() !== "unknown";
  const hasOutputHint = outputHint.length > 0 && outputHint.toLowerCase() !== "unknown";
  const hasInputSchema = inputSchemaJson.length > 0 && inputSchemaJson !== "{}";
  const hasOutputSchema = outputSchemaJson.length > 0 && outputSchemaJson !== "{}";
  const showInputHint = hasInputHint && !hasInputSchema;
  const showOutputHint = hasOutputHint && !hasOutputSchema;
  const hasDetails = description.length > 0
    || showInputHint
    || showOutputHint
    || hasInputSchema
    || hasOutputSchema;
  const showLoading = Boolean(loading);

  return (
    <div className="space-y-2.5 pb-3 pt-1 pr-2" style={{ paddingLeft: insetLeft }}>
      {showLoading ? (
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

      {description && (
        <div className="tool-description text-[12px] leading-relaxed text-muted-foreground">
          <Streamdown plugins={{ code: codePlugin }}>{description}</Streamdown>
        </div>
      )}

      {showInputHint && <TypeSignature raw={inputHint} label="Arguments" />}
      {showOutputHint && <TypeSignature raw={outputHint} label="Returns" />}

      {hasInputSchema ? <TypeSignature raw={inputSchemaJson} label="Input Schema" /> : null}
      {hasOutputSchema ? <TypeSignature raw={outputSchemaJson} label="Output Schema" /> : null}

      {!showLoading && !hasDetails ? (
        <p className="text-[11px] text-muted-foreground/60">No description or type signatures available yet.</p>
      ) : null}
    </div>
  );
}

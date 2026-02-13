"use client";

import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import type { ToolDescriptor } from "@/lib/types";
import { Skeleton } from "@/components/ui/skeleton";
import { TypeSignature } from "./explorer-type-signature";

const codePlugin = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

export function ToolDetail({
  tool,
  depth,
  loading: _loading = false,
}: {
  tool: ToolDescriptor;
  depth: number;
  loading?: boolean;
}) {
  const insetLeft = depth * 20 + 8 + 16 + 8;
  const argsType = tool.argsType?.trim() || tool.strictArgsType;
  const returnsType = tool.returnsType?.trim() || tool.strictReturnsType;
  const hasDetails = Boolean(tool.description || argsType || returnsType);

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

      {argsType && <TypeSignature raw={argsType} label="Arguments" />}
      {returnsType && <TypeSignature raw={returnsType} label="Returns" />}
    </div>
  );
}

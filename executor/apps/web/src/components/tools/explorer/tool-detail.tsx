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
}: {
  tool: ToolDescriptor;
  depth: number;
}) {
  const insetLeft = depth * 20 + 8 + 16 + 8;
  const inputHint = tool.display?.input?.trim();
  const outputHint = tool.display?.output?.trim();
  const required = tool.typing?.requiredInputKeys ?? [];
  const hasDetails = Boolean(tool.description || inputHint || outputHint || required.length > 0);

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

      {inputHint && <TypeSignature raw={inputHint} label="Arguments" />}
      {outputHint && <TypeSignature raw={outputHint} label="Returns" />}

      {required.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground/50">
            Required Keys
          </p>
          <p className="text-[11px] font-mono text-muted-foreground break-words">
            {required.join(", ")}
          </p>
        </div>
      ) : null}
    </div>
  );
}

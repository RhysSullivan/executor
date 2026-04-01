import { useMemo, useState } from "react";
import { useAtomValue, toolSchemaAtom, Result, ScopeId, ToolId } from "@executor/react";
import { CodeBlock } from "@executor/ui/components/code-block";
import { Markdown } from "@executor/ui/components/markdown";
import { schemaToTypeDeclaration } from "../lib/schema-type-signature";

// ---------------------------------------------------------------------------
// Copy button
// ---------------------------------------------------------------------------

function CopyButton(props: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(props.text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="size-6 shrink-0 flex items-center justify-center text-muted-foreground/30 hover:text-muted-foreground transition-colors"
      title={props.label ?? "Copy"}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" className="size-3.5">
          <path d="M3 8l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="size-3.5">
          <rect x="5" y="5" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M3 11V3h8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Build type declarations from schemas
// ---------------------------------------------------------------------------

const buildCallSignature = (
  toolName: string,
  inputSchema: unknown,
  outputSchema: unknown,
): string => {
  const inputType = inputSchema
    ? schemaToTypeDeclaration(inputSchema)
    : "void";
  const outputType = outputSchema
    ? schemaToTypeDeclaration(outputSchema)
    : "void";

  const leaf = toolName.split(".").pop() ?? toolName;
  return `declare function ${leaf}(input: ${inputType}): ${outputType}`;
};

// ---------------------------------------------------------------------------
// ToolDetail
// ---------------------------------------------------------------------------

export function ToolDetail(props: {
  toolId: string;
  toolName: string;
  toolDescription?: string;
  scopeId: ScopeId;
}) {
  const schema = useAtomValue(
    toolSchemaAtom(props.scopeId, props.toolId as ToolId),
  );

  const types = useMemo(() => {
    if (!Result.isSuccess(schema)) return null;
    const v = schema.value;
    return {
      input: v.inputSchema ? schemaToTypeDeclaration(v.inputSchema, "Input") : null,
      output: v.outputSchema ? schemaToTypeDeclaration(v.outputSchema, "Output") : null,
      callSignature: buildCallSignature(props.toolName, v.inputSchema, v.outputSchema),
      inputJson: v.inputSchema ? JSON.stringify(v.inputSchema, null, 2) : null,
      outputJson: v.outputSchema ? JSON.stringify(v.outputSchema, null, 2) : null,
    };
  }, [schema, props.toolName]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="flex items-start gap-3 px-5 py-3.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <svg viewBox="0 0 16 16" className="size-4">
              <path
                d="M4 2h8l1 3H3l1-3zM3 6h10v8H3V6z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-foreground font-mono">
                {props.toolName}
              </h3>
              <CopyButton text={props.toolId} label="Copy tool ID" />
            </div>
            {props.toolDescription && (
              <div className="mt-1">
                <Markdown>{props.toolDescription}</Markdown>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {Result.match(schema, {
          onInitial: () => (
            <div className="p-5 text-sm text-muted-foreground">Loading schema…</div>
          ),
          onFailure: () => (
            <div className="p-5 text-sm text-destructive">Failed to load schema</div>
          ),
          onSuccess: () => (
            <div className="space-y-4 px-5 py-4">
              {/* Call signature */}
              {types?.callSignature && (
                <CodeBlock
                  title="Call Signature"
                  code={types.callSignature}
                  lang="typescript"
                />
              )}

              {/* Type declarations */}
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {types?.input ? (
                  <CodeBlock title="Input" code={types.input} lang="typescript" />
                ) : (
                  <div className="rounded-lg border border-border bg-card/60 px-3 py-6 text-center text-[13px] text-muted-foreground/40">
                    No input
                  </div>
                )}
                {types?.output ? (
                  <CodeBlock title="Output" code={types.output} lang="typescript" />
                ) : (
                  <div className="rounded-lg border border-border bg-card/60 px-3 py-6 text-center text-[13px] text-muted-foreground/40">
                    No output
                  </div>
                )}
              </div>

              {/* JSON Schemas */}
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {types?.inputJson ? (
                  <CodeBlock title="Input Schema" code={types.inputJson} />
                ) : (
                  <div className="rounded-lg border border-border bg-card/60 px-3 py-6 text-center text-[13px] text-muted-foreground/40">
                    No input schema
                  </div>
                )}
                {types?.outputJson ? (
                  <CodeBlock title="Output Schema" code={types.outputJson} />
                ) : (
                  <div className="rounded-lg border border-border bg-card/60 px-3 py-6 text-center text-[13px] text-muted-foreground/40">
                    No output schema
                  </div>
                )}
              </div>
            </div>
          ),
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

export function ToolDetailEmpty(props: { hasTools: boolean }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <p className="text-sm font-medium text-foreground/70">
          {props.hasTools ? "Select a tool" : "No tools available"}
        </p>
        {props.hasTools && (
          <p className="mt-1 text-xs text-muted-foreground">
            Choose from the list or press{" "}
            <kbd className="rounded border border-border bg-muted px-1 py-px text-[10px]">
              /
            </kbd>{" "}
            to search.
          </p>
        )}
      </div>
    </div>
  );
}

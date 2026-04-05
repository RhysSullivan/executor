import { useMemo, useState } from "react";
import { useAtomValue, toolSchemaAtom, Result, ScopeId, ToolId } from "@executor/react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@executor/ui/components/accordion";
import { Badge } from "@executor/ui/components/badge";
import { CodeBlock } from "@executor/ui/components/code-block";
import { Markdown } from "@executor/ui/components/markdown";

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
// Build type declarations from tool TypeScript previews
// ---------------------------------------------------------------------------

const buildCallSignature = (
  toolName: string,
  inputTypeScript?: string,
  outputTypeScript?: string,
): string => {
  const inputType = inputTypeScript ?? "void";
  const outputType = outputTypeScript ?? "void";

  const leaf = toolName.split(".").pop() ?? toolName;
  return `declare function ${leaf}(input: ${inputType}): ${outputType}`;
};

const buildPrimaryContract = (input: {
  toolName: string;
  inputTypeScript?: string;
  outputTypeScript?: string;
}): string => {
  const sections = [
    buildCallSignature(input.toolName, input.inputTypeScript, input.outputTypeScript),
    input.inputTypeScript ? `type Input = ${input.inputTypeScript}` : "type Input = void",
    input.outputTypeScript ? `type Output = ${input.outputTypeScript}` : "type Output = void",
  ];

  return sections.join("\n\n");
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
  const toolContract = useAtomValue(
    toolSchemaAtom(props.scopeId, props.toolId as ToolId),
  );

  const types = useMemo(() => {
    if (!Result.isSuccess(toolContract)) return null;
    const v = toolContract.value;
    const definitions = Object.entries(v.typeScriptDefinitions ?? {}).map(([name, body]) => ({
      name,
      code: `type ${name} = ${body}`,
    }));

    return {
      inputTypeScript: v.inputTypeScript,
      outputTypeScript: v.outputTypeScript,
      contract: buildPrimaryContract({
        toolName: props.toolName,
        inputTypeScript: v.inputTypeScript,
        outputTypeScript: v.outputTypeScript,
      }),
      definitions,
    };
  }, [toolContract, props.toolName]);

  const namespace = props.toolName.split(".").slice(0, -1).join(".") || "global";

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[radial-gradient(circle_at_top,rgba(120,119,198,0.08),transparent_32%),linear-gradient(to_bottom,rgba(255,255,255,0.02),transparent_24%)]">
      <div className="shrink-0 border-b border-border/70 bg-background/90 backdrop-blur-xl">
        <div className="px-5 py-4">
          <div className="flex items-start gap-4">
            <div className="relative mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-primary shadow-[0_10px_30px_rgba(120,119,198,0.12)]">
              <div className="absolute inset-0 rounded-2xl bg-[linear-gradient(135deg,rgba(255,255,255,0.14),transparent_55%)]" />
              <svg viewBox="0 0 16 16" className="relative size-4">
                <path
                  d="M4 2h8l1 3H3l1-3zM3 6h10v8H3V6z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="rounded-full border-primary/20 bg-primary/5 px-2.5 py-1 font-mono text-[10px] tracking-[0.18em] text-primary/80 uppercase">
                  {namespace}
                </Badge>
                <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground/80">
                  {types?.definitions.length ?? 0} shared type{(types?.definitions.length ?? 0) === 1 ? "" : "s"}
                </Badge>
              </div>
              <div className="mt-2 flex items-start gap-2">
                <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground font-mono leading-6">
                  {props.toolName}
                </h3>
                <CopyButton text={props.toolId} label="Copy tool ID" />
              </div>
              {props.toolDescription && (
                <div className="mt-2 max-w-2xl text-sm text-muted-foreground/90">
                  <Markdown>{props.toolDescription}</Markdown>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {Result.match(toolContract, {
          onInitial: () => (
            <div className="p-5 text-sm text-muted-foreground">Loading tool contract…</div>
          ),
          onFailure: () => (
            <div className="p-5 text-sm text-destructive">Failed to load tool contract</div>
          ),
          onSuccess: () => (
            <div className="space-y-4 px-5 py-4">
              <div className="rounded-2xl border border-border/70 bg-card/70 shadow-[0_12px_40px_rgba(0,0,0,0.04)] overflow-hidden">
                <div className="flex items-center justify-between border-b border-border/70 bg-muted/30 px-4 py-3">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/75">
                      Primary contract
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground/80">
                      One compact view for the call signature, input, and output.
                    </p>
                  </div>
                  <div className="hidden items-center gap-2 sm:flex">
                    <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.16em]">
                      {types?.inputTypeScript ? "input" : "no input"}
                    </Badge>
                    <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.16em]">
                      {types?.outputTypeScript ? "output" : "no output"}
                    </Badge>
                  </div>
                </div>
                <div className="p-4">
                  {types?.contract && (
                    <CodeBlock
                      code={types.contract}
                      lang="typescript"
                      className="rounded-xl border-border/60 bg-background/70"
                    />
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-border/70 bg-card/50 px-4 py-3 shadow-[0_8px_30px_rgba(0,0,0,0.03)]">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground/75">
                      Shared definitions
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground/80">
                      Referenced types stay tucked away until you need them.
                    </p>
                  </div>
                  <Badge variant="outline" className="rounded-full px-2.5 py-1 text-[10px] uppercase tracking-[0.16em]">
                    {types?.definitions.length ?? 0}
                  </Badge>
                </div>

                {types && types.definitions.length > 0 ? (
                  <Accordion type="multiple" className="mt-3 divide-y divide-border/60">
                    {types.definitions.map((definition) => (
                      <AccordionItem key={definition.name} value={definition.name} className="border-none">
                        <AccordionTrigger className="py-3 hover:no-underline">
                          <div className="flex min-w-0 items-center gap-3">
                            <div className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-background/80 text-[11px] font-medium text-muted-foreground">
                              TS
                            </div>
                            <div className="min-w-0">
                              <div className="truncate font-mono text-sm text-foreground">
                                {definition.name}
                              </div>
                              <div className="text-xs text-muted-foreground/75">
                                Referenced by the primary contract
                              </div>
                            </div>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent className="pb-1">
                          <CodeBlock
                            code={definition.code}
                            lang="typescript"
                            className="rounded-xl border-border/60 bg-background/70"
                          />
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                ) : (
                  <div className="mt-3 rounded-xl border border-dashed border-border/70 bg-background/40 px-4 py-5 text-center text-[13px] text-muted-foreground/65">
                    This contract is self-contained — no extra referenced types.
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

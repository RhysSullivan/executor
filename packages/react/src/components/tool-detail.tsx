import { useMemo, useState } from "react";
import { useAtomValue, Result } from "@effect-atom/atom-react";
import { toolSchemaAtom } from "../api/atoms";
import { ScopeId, ToolId } from "@executor/sdk";
import { Button } from "./button";
import { Markdown } from "./markdown";
import { SchemaExplorer } from "./schema-explorer";
import { ExpandableCodeBlock } from "./expandable-code-block";
import { CardStack, CardStackHeader, CardStackContent } from "./card-stack";
import { CopyButton } from "./copy-button";
import { ChevronRight } from "lucide-react";

function EmptySection(props: { title: string; message: string }) {
  return (
    <CardStack>
      <CardStackHeader>{props.title}</CardStackHeader>
      <CardStackContent>
        <p className="px-4 py-3 text-sm text-muted-foreground">{props.message}</p>
      </CardStackContent>
    </CardStack>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const friendlyName = (name: string): string => {
  const leaf = name.split(".").pop() ?? name;
  return leaf
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_.-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

const breadcrumbParts = (name: string): string[] =>
  name.split(".").map((p) =>
    p
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()),
  );

// ---------------------------------------------------------------------------
// ToolDetail
// ---------------------------------------------------------------------------

export function ToolDetail(props: {
  toolId: string;
  toolName: string;
  toolDescription?: string;
  scopeId: ScopeId;
}) {
  const toolContract = useAtomValue(toolSchemaAtom(props.scopeId, props.toolId as ToolId));
  const [tab, setTab] = useState<"schema" | "typescript">("schema");

  const data = useMemo(() => {
    if (!Result.isSuccess(toolContract)) return null;
    const v = toolContract.value;
    const definitions = Object.entries(v.typeScriptDefinitions ?? {}).map(([name, body]) => ({
      name,
      code: body,
    }));

    return {
      inputSchema: v.inputSchema,
      outputSchema: v.outputSchema,
      inputTypeScript: v.inputTypeScript ? `type Input = ${v.inputTypeScript}` : null,
      outputTypeScript: v.outputTypeScript ? `type Output = ${v.outputTypeScript}` : null,
      definitions,
    };
  }, [toolContract]);

  const crumbs = breadcrumbParts(props.toolName);
  const displayName = friendlyName(props.toolName);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header + tabs */}
      <div className="shrink-0 border-b border-border/40">
        <div className="px-5 pt-4 pb-0">
          {crumbs.length > 1 && (
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              {crumbs.slice(0, -1).map((part, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight className="size-3 shrink-0" />}
                  <span>{part}</span>
                </span>
              ))}
            </div>
          )}
          <div className="mt-1 flex items-center gap-2">
            <h3 className="text-base font-semibold text-foreground truncate">{displayName}</h3>
            <CopyButton value={props.toolId} label="Copy tool ID" />
          </div>
          {props.toolDescription && (
            <div className="mt-1.5 max-w-lg text-sm text-muted-foreground line-clamp-2">
              <Markdown>{props.toolDescription}</Markdown>
            </div>
          )}

          {/* Tabs */}
          <div className="mt-3 flex gap-4" role="tablist">
            <Button
              variant="ghost"
              role="tab"
              aria-selected={tab === "schema"}
              onClick={() => setTab("schema")}
              className={[
                "border-b-2 pb-2.5 text-sm font-medium transition-colors rounded-none",
                tab === "schema"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              Schema
            </Button>
            <Button
              variant="ghost"
              role="tab"
              aria-selected={tab === "typescript"}
              onClick={() => setTab("typescript")}
              className={[
                "border-b-2 pb-2.5 text-sm font-medium transition-colors rounded-none",
                tab === "typescript"
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              ].join(" ")}
            >
              TypeScript
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {Result.match(toolContract, {
          onInitial: () => <div className="p-5 text-sm text-muted-foreground">Loading…</div>,
          onFailure: () => <div className="p-5 text-sm text-destructive">Something went wrong</div>,
          onSuccess: () =>
            tab === "schema" ? (
              <div className="px-5 py-5 space-y-5">
                {data?.inputSchema ? (
                  <SchemaExplorer schema={data.inputSchema} title="Parameters" />
                ) : (
                  <EmptySection title="Parameters" message="None" />
                )}
                {data?.outputSchema ? (
                  <SchemaExplorer schema={data.outputSchema} title="Response" />
                ) : (
                  <EmptySection title="Response" message="None" />
                )}
              </div>
            ) : (
              <div className="px-5 py-5 space-y-5">
                {data?.inputTypeScript ? (
                  <CardStack>
                    <CardStackHeader>Input</CardStackHeader>
                    <CardStackContent>
                      <ExpandableCodeBlock
                        code={data.inputTypeScript}
                        definitions={data.definitions}
                        className="rounded-none border-0"
                      />
                    </CardStackContent>
                  </CardStack>
                ) : (
                  <EmptySection title="Input" message="void" />
                )}
                {data?.outputTypeScript ? (
                  <CardStack>
                    <CardStackHeader>Output</CardStackHeader>
                    <CardStackContent>
                      <ExpandableCodeBlock
                        code={data.outputTypeScript}
                        definitions={data.definitions}
                        className="rounded-none border-0"
                      />
                    </CardStackContent>
                  </CardStack>
                ) : (
                  <EmptySection title="Output" message="void" />
                )}
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
        <p className="text-sm font-medium text-foreground">
          {props.hasTools ? "Select a tool" : "No tools available"}
        </p>
        {props.hasTools && (
          <p className="mt-1.5 text-sm text-muted-foreground">
            Choose from the list to see what it does.
          </p>
        )}
      </div>
    </div>
  );
}

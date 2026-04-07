import { useEffect, useState } from "react";
import { Button } from "@executor/ui/components/button";
import { CodeBlock } from "@executor/ui/components/code-block";
import { useScopeInfo } from "@executor/react";

type TransportMode = "stdio" | "http";

const isDev = import.meta.env.DEV;

export function McpInstallCard(props: { className?: string }) {
  const [mode, setMode] = useState<TransportMode>("stdio");
  const [origin, setOrigin] = useState<string | null>(null);
  const scopeInfo = useScopeInfo();

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const scopeFlag = scopeInfo.dir ? ` --scope ${JSON.stringify(scopeInfo.dir)}` : "";

  const command =
    mode === "stdio"
      ? isDev
        ? `npx add-mcp "bun run dev:cli mcp${scopeFlag}" --name "executor"`
        : `npx add-mcp "executor mcp${scopeFlag}" --name "executor"`
      : origin
        ? `npx add-mcp "${origin}/mcp" --transport http --name "executor"`
        : 'npx add-mcp "<this-server>/mcp" --transport http --name "executor"';

  const description =
    mode === "stdio"
      ? "Starts executor as a local stdio MCP server. Best for CLI agents like Claude Code."
      : "Use the current web origin as a remote MCP endpoint over streamable HTTP.";

  return (
    <section
      className={
        props.className ??
        "rounded-2xl border border-border bg-card/80 p-5"
      }
    >
      <div className="mb-3 space-y-1">
        <h2 className="text-sm font-semibold text-foreground">
          Connect an agent
        </h2>
        <p className="text-[13px] text-muted-foreground">{description}</p>
      </div>

      {/* Transport toggle */}
      <div className="mb-3 inline-flex rounded-lg border border-border bg-background/70 p-1">
        {(
          [
            { key: "http", label: "Remote HTTP" },
            { key: "stdio", label: "Standard I/O" },
          ] as const
        ).map((opt) => (
          <Button
            key={opt.key}
            type="button"
            variant={mode === opt.key ? "default" : "ghost"}
            size="sm"
            onClick={() => setMode(opt.key)}
            className="rounded-md px-3 py-1.5"
          >
            {opt.label}
          </Button>
        ))}
      </div>

      <CodeBlock code={command} lang="bash" />

      {mode === "stdio" && (
        <p className="mt-3 text-[12px] text-muted-foreground">
          {isDev
            ? "Uses the repo-local dev CLI. Run from the repository root."
            : "Requires the executor CLI on your PATH."}
        </p>
      )}
    </section>
  );
}

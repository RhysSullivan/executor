import { useEffect, useState } from "react";
import { CodeBlock } from "./code-block";
import { cn } from "../lib/utils";

type LocalMcpInstallMode = "stdio" | "http";

const isDevBuild = import.meta.env.DEV;

export function LocalMcpInstallCard(props: {
  title?: string;
  description?: string;
  className?: string;
}) {
  const [origin, setOrigin] = useState<string | null>(null);
  const [mode, setMode] = useState<LocalMcpInstallMode>("stdio");

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const command = mode === "stdio"
    ? isDevBuild
      ? 'npx add-mcp "bun run executor mcp --stdio" --name "executor-stdio"'
      : 'npx add-mcp "executor mcp --stdio" --name "executor-stdio"'
    : origin
      ? `npx add-mcp "${origin}/mcp" --transport http --name "executor"`
      : 'npx add-mcp "<this-server>/mcp" --transport http --name "executor"';

  return (
    <section className={props.className ?? "rounded-2xl border border-border bg-card/80 p-5"}>
      <div className="mb-3 space-y-1">
        <h2 className="text-sm font-semibold text-foreground">
          {props.title ?? "Install local MCP"}
        </h2>
        <p className="text-[13px] text-muted-foreground">
          {props.description
            ?? (mode === "stdio"
              ? "Preferred for local agents. This installs executor as a stdio MCP command and starts a local web sidecar automatically when needed."
              : "Use the current web origin as a remote MCP endpoint over HTTP.")}
        </p>
      </div>
      <div className="mb-3 inline-flex rounded-lg border border-border bg-background/70 p-1">
        {[
          { key: "stdio" as const, label: "Standard I/O" },
          { key: "http" as const, label: "Remote HTTP" },
        ].map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => setMode(option.key)}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              mode === option.key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <CodeBlock code={command} lang="bash" className="rounded-xl border border-border bg-background/70" />
      {mode === "stdio" ? (
        <div className="mt-3 space-y-1 text-[12px] text-muted-foreground">
          {!isDevBuild ? (
            <p>
              Requires the `executor` CLI on your PATH. Uses a distinct MCP name to avoid colliding with an existing remote `executor` entry.
            </p>
          ) : (
            <>
              <p>
                Uses the repo-local dev CLI: <code>bun run executor mcp --stdio</code>.
              </p>
              <p>
                Run the `add-mcp` command from the repository root, or set your MCP client working directory to this repo before using the saved entry.
              </p>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

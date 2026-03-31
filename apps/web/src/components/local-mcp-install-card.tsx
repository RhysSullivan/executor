import { useEffect, useRef, useState } from "react";
import { Button } from "@executor/react/plugins";
import { CodeBlock } from "./code-block";

type LocalMcpInstallMode = "stdio" | "http";

const isDevBuild = import.meta.env.DEV;

/**
 * Fetch the execute tool description from the local MCP server using the
 * Streamable HTTP transport. Performs initialize → tools/list → returns the
 * description of the "execute" tool.
 */
async function fetchExecuteToolDescription(
  mcpOrigin: string,
): Promise<string | null> {
  const endpoint = `${mcpOrigin}/mcp`;

  const jsonRpcHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };

  // 1. Initialize – get a session id
  const initRes = await fetch(endpoint, {
    method: "POST",
    headers: jsonRpcHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "executor-web", version: "0.1.0" },
      },
    }),
  });

  const sessionId = initRes.headers.get("mcp-session-id");
  if (!sessionId) return null;

  // 2. List tools
  const listRes = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...jsonRpcHeaders,
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });

  const listBody = await listRes.json();
  const tools: Array<{ name: string; description?: string }> =
    listBody?.result?.tools ?? [];

  const executeTool = tools.find((t) => t.name === "execute");

  // 3. Tear down the session (best-effort)
  void fetch(endpoint, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId },
  }).catch(() => {});

  return executeTool?.description ?? null;
}

function ToolDescriptionDisclosure() {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  // Fetch lazily on first open
  useEffect(() => {
    if (!open || fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    fetchExecuteToolDescription(window.location.origin)
      .then(setDescription)
      .catch(() => setDescription(null))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (bodyRef.current) {
      setHeight(bodyRef.current.scrollHeight);
    }
  }, [open, description, loading]);

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground/70 transition-colors hover:text-foreground/80"
      >
        <svg
          viewBox="0 0 10 10"
          className="size-2.5 fill-current transition-transform duration-200"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          <path d="M3 1.5 L7 5 L3 8.5Z" />
        </svg>
        <span>View tool description</span>
      </button>
      <div
        className="overflow-hidden transition-[max-height,opacity] duration-200 ease-out"
        style={{
          maxHeight: open ? height : 0,
          opacity: open ? 1 : 0,
        }}
      >
        <div ref={bodyRef}>
          {loading ? (
            <p className="mt-2 text-[11px] text-muted-foreground/60">
              Loading...
            </p>
          ) : description ? (
            <pre className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-border/60 bg-background/50 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {description}
            </pre>
          ) : open && !loading ? (
            <p className="mt-2 text-[11px] text-muted-foreground/60">
              Could not load tool description.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

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
          <Button
            key={option.key}
            type="button"
            variant={mode === option.key ? "default" : "ghost"}
            size="sm"
            onClick={() => setMode(option.key)}
            className="rounded-md px-3 py-1.5"
          >
            {option.label}
          </Button>
        ))}
      </div>
      <CodeBlock code={command} lang="bash" className="rounded-xl border border-border bg-background/70" />
      <ToolDescriptionDisclosure />
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

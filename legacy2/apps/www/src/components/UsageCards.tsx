const CARDS = [
  {
    title: "Use via CLI",
    code: `curl -fsSL https://executor.sh/install | bash
executor up
executor claude`,
    description:
      "Install the binary, start the managed backend, and launch Claude Code wired to Executor. One command to go from zero to sandboxed tool calling.",
  },
  {
    title: "Use via AI SDK",
    code: `import { createMcpClient } from "ai/mcp"

const client = createMcpClient({
  url: "https://your-instance.executor.sh/mcp",
  apiKey: process.env.EXECUTOR_API_KEY,
})`,
    description:
      "Connect any MCP-compatible client — Vercel AI SDK, LangChain, or your own. Standard Streamable HTTP transport.",
  },
  {
    title: "Use locally",
    code: `executor up         # start backend
executor web        # open dashboard
executor doctor     # health check

# Or wire up Claude Code directly:
executor claude --no-bash`,
    description:
      "Fully self-hosted. Run locally with SQLite for development, or connect to your own Postgres backend. No cloud dependency required.",
  },
  {
    title: "Use with your team",
    code: `# Organization → Workspaces → Roles
# Policies govern every tool call

executor org invite teammate@co.com
executor workspace create staging
executor policy set --role "read-only" \\
  --scope workspace:staging`,
    description:
      "Workspaces, roles, policies, and audit trails. Give your team access with the exact permissions they need.",
  },
];

export function UsageCards() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {CARDS.map((card) => (
        <div
          key={card.title}
          className="bg-surface border border-white/[0.06] rounded-lg overflow-hidden"
        >
          <div className="px-5 py-4 border-b border-white/[0.06]">
            <h4 className="font-serif text-lg font-normal text-[#f5f5f5]">
              {card.title}
            </h4>
          </div>
          <div className="p-4">
            <pre className="!m-0 !p-3 !bg-white/[0.02] !border !border-white/[0.06] !rounded-md mb-4 overflow-x-auto">
              <code className="!bg-transparent !p-0 font-mono text-[0.75rem] leading-6 text-white/60">
                {card.code}
              </code>
            </pre>
            <p className="text-sm text-white/50 leading-relaxed">
              {card.description}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

import { useState, useEffect } from "react";

const SYSTEM_PROMPT_LINES = [
  "You have access to the `execute` tool.",
  "Use it to run TypeScript code in a sandboxed runtime.",
  "",
  "The sandbox provides a `tools` object with typed methods:",
  "  tools.cloudflare.*  — DNS, Workers, R2, KV, Zones",
  "  tools.vercel.*      — Deployments, Domains, Projects",
  "  tools.posthog.*     — Events, Funnels, Feature Flags",
  "",
  "To discover available tools, use:",
  '  tools.catalog.namespaces({})       // list all sources',
  '  tools.catalog.tools({ namespace }) // list tools in source',
  '  tools.discover({ query })          // ranked search',
  "",
  "All tool calls are policy-governed. Sensitive operations",
  "may require human approval before executing.",
];

export function SystemPrompt() {
  const [tokenCount, setTokenCount] = useState(1024);

  // Simulate slight token fluctuation to make it feel alive
  useEffect(() => {
    const interval = setInterval(() => {
      setTokenCount((prev) => {
        const delta = Math.floor(Math.random() * 40) - 20;
        return Math.max(960, Math.min(1088, prev + delta));
      });
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs uppercase tracking-widest text-white/40">
          System prompt injection
        </span>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          <span className="font-mono text-sm text-green-400">
            ~{tokenCount.toLocaleString()} tokens
          </span>
        </div>
      </div>
      <div className="bg-surface border border-white/[0.06] rounded-lg overflow-hidden">
        <div className="px-4 py-3 bg-white/[0.02] border-b border-white/[0.06] flex items-center gap-2">
          <span className="text-[0.65rem] uppercase tracking-widest text-white/30">
            system
          </span>
        </div>
        <div className="p-4 font-mono text-[0.8rem] leading-7 text-white/60 overflow-x-auto">
          {SYSTEM_PROMPT_LINES.map((line, i) => (
            <div
              key={i}
              className={line === "" ? "h-4" : undefined}
            >
              {line}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-4 px-4 py-3 bg-blue-500/[0.05] border-l-2 border-blue-400 text-sm text-white/60">
        No matter how many sources you add, the system prompt stays under{" "}
        <span className="text-[#f5f5f5] font-medium">~1k tokens</span>.
        Tools are discovered on-demand, not dumped into context.
      </div>
    </div>
  );
}

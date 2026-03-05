import { useState } from "react";

interface Example {
  query: string;
  sources: string[];
  toolCalls: number;
  description: string;
}

const EXAMPLES: Example[] = [
  {
    query: "List all DNS records for example.com and check if any point to deprecated IPs",
    sources: ["cloudflare"],
    toolCalls: 2,
    description:
      "Discovers zone tools, queries DNS records, filters results — all in one sandboxed execution.",
  },
  {
    query: "Show me the deploy status for the last 5 production deploys and rollback if the latest is failing",
    sources: ["vercel"],
    toolCalls: 3,
    description:
      "Lists deployments, checks health, conditionally triggers rollback. Rollback requires approval.",
  },
  {
    query: "Find the top 10 most triggered feature flags this week and compare with last week",
    sources: ["posthog"],
    toolCalls: 4,
    description:
      "Queries feature flag events across two date ranges, computes deltas, returns sorted comparison.",
  },
  {
    query: "Create a new private repo, set up branch protection, and add the team as collaborators",
    sources: ["github"],
    toolCalls: 5,
    description:
      "Multi-step workflow: creates repo, configures branch rules, adds team. Each write requires approval.",
  },
  {
    query: "Check our Stripe MRR, compare with last month, and list any failed charges over $100",
    sources: ["stripe"],
    toolCalls: 3,
    description:
      "Aggregates subscription revenue, queries failed charges with amount filter — pure read operations.",
  },
];

export function ExampleQueries() {
  const [active, setActive] = useState(0);
  const example = EXAMPLES[active];

  return (
    <div>
      {/* Query list */}
      <div className="space-y-2 mb-6">
        {EXAMPLES.map((ex, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            className={`w-full text-left p-4 rounded-lg border transition-all duration-200 ${
              i === active
                ? "border-accent/40 bg-accent/[0.06]"
                : "border-white/[0.06] bg-white/[0.02] hover:border-white/15"
            }`}
          >
            <div className="flex items-start gap-3">
              <span className="text-accent font-mono text-xs mt-0.5 shrink-0">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span
                className={`text-sm leading-relaxed ${
                  i === active ? "text-[#f5f5f5]" : "text-white/60"
                }`}
              >
                {ex.query}
              </span>
            </div>
          </button>
        ))}
      </div>
      {/* Detail panel */}
      <div className="bg-surface border border-white/[0.06] rounded-lg p-5">
        <div className="flex items-center gap-4 mb-4">
          <div className="flex items-center gap-2">
            {example.sources.map((s) => (
              <span
                key={s}
                className="text-[0.65rem] uppercase tracking-widest px-2 py-1 rounded bg-white/[0.06] text-white/50"
              >
                {s}
              </span>
            ))}
          </div>
          <span className="text-xs text-white/30">
            {example.toolCalls} tool call{example.toolCalls !== 1 ? "s" : ""}
          </span>
        </div>
        <p className="text-sm text-white/60 leading-relaxed">
          {example.description}
        </p>
      </div>
    </div>
  );
}

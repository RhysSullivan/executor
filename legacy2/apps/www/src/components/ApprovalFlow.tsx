import { useState, useEffect } from "react";

type ApprovalState = "pending" | "reviewing" | "approved" | "denied";

interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  risk: "low" | "medium" | "high";
}

const TOOL_CALL: ToolCall = {
  tool: "cloudflare.create_dns_record",
  input: {
    zone_id: "z_8f7a2b3c4d5e6f",
    type: "A",
    name: "api.example.com",
    content: "192.0.2.1",
    proxied: true,
  },
  risk: "medium",
};

export function ApprovalFlow() {
  const [state, setState] = useState<ApprovalState>("pending");
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (state === "pending") {
      const interval = setInterval(() => setElapsed((e) => e + 1), 1000);
      return () => clearInterval(interval);
    }
  }, [state]);

  const reset = () => {
    setState("pending");
    setElapsed(0);
  };

  const riskColors = {
    low: "text-green-400 bg-green-400/10 border-green-400/20",
    medium: "text-yellow-400 bg-yellow-400/10 border-yellow-400/20",
    high: "text-red-400 bg-red-400/10 border-red-400/20",
  };

  return (
    <div className="bg-surface border border-white/[0.06] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 bg-white/[0.02] border-b border-white/[0.06] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`w-2 h-2 rounded-full ${
              state === "pending"
                ? "bg-yellow-400 animate-pulse"
                : state === "approved"
                  ? "bg-green-400"
                  : state === "denied"
                    ? "bg-red-400"
                    : "bg-blue-400 animate-pulse"
            }`}
          />
          <span className="text-sm font-medium text-[#f5f5f5]">
            Approval Request
          </span>
          <span
            className={`text-[0.65rem] uppercase tracking-widest px-2 py-0.5 rounded border ${riskColors[TOOL_CALL.risk]}`}
          >
            {TOOL_CALL.risk} risk
          </span>
        </div>
        {state !== "pending" && (
          <button
            onClick={reset}
            className="text-xs text-white/30 hover:text-white/60 transition-colors"
          >
            Reset
          </button>
        )}
      </div>

      {/* Body */}
      <div className="p-5">
        {/* Tool call details */}
        <div className="mb-4">
          <div className="text-xs uppercase tracking-widest text-white/30 mb-2">
            Tool
          </div>
          <code className="text-sm text-accent">{TOOL_CALL.tool}</code>
        </div>
        <div className="mb-5">
          <div className="text-xs uppercase tracking-widest text-white/30 mb-2">
            Input
          </div>
          <pre className="!m-0 !p-3 !bg-white/[0.02] !border !border-white/[0.06] !rounded-md">
            <code className="!bg-transparent !p-0 font-mono text-xs text-white/60">
              {JSON.stringify(TOOL_CALL.input, null, 2)}
            </code>
          </pre>
        </div>

        {/* State display */}
        {state === "pending" && (
          <div>
            <div className="flex items-center gap-2 mb-4 text-sm text-white/40">
              <span className="w-3 h-3 border-2 border-yellow-400/30 border-t-yellow-400 rounded-full animate-spin" />
              Waiting for approval... ({elapsed}s)
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setState("approved")}
                className="flex-1 py-2.5 rounded-md bg-green-500/10 border border-green-500/20 text-green-400 text-sm font-medium hover:bg-green-500/20 transition-all active:scale-[0.98]"
              >
                ✓ Approve
              </button>
              <button
                onClick={() => setState("denied")}
                className="flex-1 py-2.5 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-sm font-medium hover:bg-red-500/20 transition-all active:scale-[0.98]"
              >
                ✗ Deny
              </button>
            </div>
          </div>
        )}

        {state === "approved" && (
          <div className="animate-log-fade-in">
            <div className="flex items-center gap-2 mb-3 text-sm text-green-400">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Approved — execution resumed
            </div>
            <div className="font-mono text-xs text-white/40 space-y-1">
              <div>→ Credential resolved: cf_api_token_****</div>
              <div>→ POST /zones/z_8f7a2b3c/dns_records</div>
              <div className="text-green-400/60">→ 200 OK — DNS record created</div>
            </div>
          </div>
        )}

        {state === "denied" && (
          <div className="animate-log-fade-in">
            <div className="flex items-center gap-2 mb-3 text-sm text-red-400">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
              Denied — tool call blocked
            </div>
            <div className="font-mono text-xs text-white/40 space-y-1">
              <div>→ Approval denied by operator</div>
              <div>→ ToolCallControlError: approval_denied</div>
              <div className="text-white/30">→ Agent notified, task ended gracefully</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

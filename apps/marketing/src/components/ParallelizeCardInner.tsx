import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// Pre-computed Shiki tokens (github-light theme, TypeScript)
// Generated from: const [issues, prs, messages] = await Promise.all([
//   tools.linear.listIssues({ assignee: "me" }),
//   tools.github.listPRs({ state: "open" }),
//   tools.slack.listMessages({ channel: "#dev" }),
// ])
const CODE_TOKENS: [string, string][][] = [
  [
    ["const", "#D73A49"],
    [" [", "#24292E"],
    ["issues", "#005CC5"],
    [", ", "#24292E"],
    ["prs", "#005CC5"],
    [", ", "#24292E"],
    ["messages", "#005CC5"],
    ["] ", "#24292E"],
    ["=", "#D73A49"],
    [" ", "#24292E"],
    ["await", "#D73A49"],
    [" ", "#24292E"],
    ["Promise", "#005CC5"],
    [".", "#24292E"],
    ["all", "#6F42C1"],
    ["([", "#24292E"],
  ],
  [
    ["  tools.linear.", "#24292E"],
    ["listIssues", "#6F42C1"],
    ["({ assignee: ", "#24292E"],
    ['"me"', "#032F62"],
    [" }),", "#24292E"],
  ],
  [
    ["  tools.github.", "#24292E"],
    ["listPRs", "#6F42C1"],
    ["({ state: ", "#24292E"],
    ['"open"', "#032F62"],
    [" }),", "#24292E"],
  ],
  [
    ["  tools.slack.", "#24292E"],
    ["listMessages", "#6F42C1"],
    ["({ channel: ", "#24292E"],
    ['"#dev"', "#032F62"],
    [" }),", "#24292E"],
  ],
  [["])", "#24292E"]],
  [["", "#24292E"]],
  [["// → issues: [{ id: \"LIN-142\", ... }, ...]", "#6A737D"]],
  [["//   prs: [{ number: 87, ... }, ...]", "#6A737D"]],
  [["//   messages: [{ text: \"deployed v2.1\", ... }, ...]", "#6A737D"]],
];

const TOOLS = [
  { text: "Show executor CLI help for MCP usage", meta: "executor, true" },
  {
    text: "Find executor config in workspace or sibling repo",
    meta: "find, 2+",
  },
  { text: "Run executor call to list available tool sources", meta: "cd, 2+" },
  { text: "Search executor tools for Linear issue listing", meta: "cd, 2+" },
  {
    text: "List latest Linear issues assigned to me via executor",
    meta: "cd, 2+",
  },
];

// 1=header, 2=desc, 3=explored, 4=discovering,
// 5=tool0, 6=explored2, 7=tool1, 8=tool2, 9=tool3, 10=tool4,
// 11=parsing, 12=button
const STEP_DELAYS = [
  0, 300, 700, 1000, 1400, 1800, 2400, 2800, 3400, 4000, 4600, 5200, 6000,
];
const CHECK_DELAYS = [2100, 3100, 3700, 4300, 4900];

const TIMER_DURATION = 6000;
const TIMER_MAX = 37;
const TYPE_SPEED = 8;

export default function ParallelizeCardInner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const timeouts = useRef<number[]>([]);
  const raf = useRef(0);

  const [step, setStep] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [timer, setTimer] = useState(0);
  const [phase, setPhase] = useState<"tools" | "fading" | "code">("tools");
  const [codeChars, setCodeChars] = useState(0);
  const [showHeadline, setShowHeadline] = useState(false);
  const [lockedHeight, setLockedHeight] = useState<number | undefined>(
    undefined,
  );

  const chars = useMemo(
    () =>
      CODE_TOKENS.flatMap((line, i) => {
        const cs = line.flatMap(([content, color]) =>
          [...content].map((ch) => ({ ch, color })),
        );
        if (i < CODE_TOKENS.length - 1) cs.push({ ch: "\n", color: "#24292e" });
        return cs;
      }),
    [],
  );

  const startAnimation = useCallback(() => {
    timeouts.current.forEach(clearTimeout);
    cancelAnimationFrame(raf.current);
    timeouts.current = [];

    setStep(0);
    setChecked(new Set());
    setTimer(0);
    setPhase("tools");
    setCodeChars(0);
    setShowHeadline(false);
    setLockedHeight(undefined);

    for (let i = 1; i < STEP_DELAYS.length; i++) {
      timeouts.current.push(
        window.setTimeout(() => setStep(i), STEP_DELAYS[i]),
      );
    }

    CHECK_DELAYS.forEach((d, i) => {
      timeouts.current.push(
        window.setTimeout(() => setChecked((prev) => new Set([...prev, i])), d),
      );
    });

    const t0 = performance.now();
    const tick = () => {
      const p = Math.min((performance.now() - t0) / TIMER_DURATION, 1);
      setTimer(Math.round(p * p * TIMER_MAX));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, []);

  // Cleanup on unmount
  useEffect(
    () => () => {
      timeouts.current.forEach(clearTimeout);
      cancelAnimationFrame(raf.current);
    },
    [],
  );

  // Start animation when visible
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || started.current) return;
        started.current = true;
        observer.disconnect();
        startAnimation();
      },
      { threshold: 0.2 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [startAnimation]);

  const handleFixMe = useCallback(() => {
    if (containerRef.current) {
      setLockedHeight(containerRef.current.offsetHeight);
    }
    setPhase("fading");
    setShowHeadline(true);
    timeouts.current.push(
      window.setTimeout(() => {
        setPhase("code");
        let i = 0;
        const total = chars.length;
        const interval = window.setInterval(() => {
          i++;
          setCodeChars(i);
          if (i >= total) clearInterval(interval);
        }, TYPE_SPEED);
      }, 350),
    );
  }, [chars.length]);

  const v = (n: number) => step >= n;

  return (
    <div
      ref={containerRef}
      className="group w-full overflow-hidden relative"
      style={lockedHeight ? { height: lockedHeight } : undefined}
    >
      <style
        dangerouslySetInnerHTML={{
          __html: `@keyframes cursor-blink{0%,100%{opacity:1}50%{opacity:0}}`,
        }}
      />

      {/* oxlint-disable-next-line react/forbid-elements */}
      <button
        onClick={startAnimation}
        className="absolute top-3 right-3 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-200 cursor-pointer p-1.5 rounded-md hover:bg-muted/60 text-muted-foreground hover:text-foreground"
        aria-label="Replay animation"
      >
        <svg
          className="w-3.5 h-3.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
      </button>

      {/* Tool calls */}
      {phase !== "code" && (
        <div
          className="px-5 pt-4 pb-16 relative"
          style={{
            opacity: phase === "fading" ? 0 : 1,
            transition: "opacity 0.4s cubic-bezier(0.16,1,0.3,1)",
          }}
        >
          <div
            className="flex items-center gap-1 text-[12px] text-muted-foreground mb-2 transition-opacity duration-300"
            style={{ opacity: v(1) ? 1 : 0 }}
          >
            Worked for {timer}s
            <svg
              className="w-3 h-3"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>

          <p
            className="text-[12px] text-foreground/80 leading-relaxed mb-1.5 transition-opacity duration-300"
            style={{ opacity: v(2) ? 1 : 0 }}
          >
            Searching the codebase and MCP configuration for how we fetch Linear
            tickets via &ldquo;executor&rdquo;.
          </p>

          <p
            className="text-[11px] text-muted-foreground mb-3 transition-opacity duration-300"
            style={{ opacity: v(3) ? 1 : 0 }}
          >
            Explored 1 file, 3 searches
          </p>

          <p
            className="text-[12px] font-medium text-foreground mb-2.5 transition-opacity duration-300"
            style={{ opacity: v(4) ? 1 : 0 }}
          >
            Discovering executor MCP tools and how to query Linear.
          </p>

          <div className="flex flex-col gap-1.5 text-[11px]">
            <ToolRow
              visible={v(5)}
              checked={checked.has(0)}
              text={TOOLS[0].text}
              meta={TOOLS[0].meta}
            />

            <p
              className="text-muted-foreground pl-[22px] -my-0.5 transition-opacity duration-300"
              style={{ opacity: v(6) ? 1 : 0 }}
            >
              Explored 1 file, 3 searches
            </p>

            {[1, 2, 3, 4].map((i) => (
              <ToolRow
                key={i}
                visible={v(i + 6)}
                checked={checked.has(i)}
                text={TOOLS[i].text}
                meta={TOOLS[i].meta}
              />
            ))}
          </div>

          <p
            className="text-[11px] text-muted-foreground mt-2.5 transition-opacity duration-300"
            style={{ opacity: v(11) ? 1 : 0 }}
          >
            Parsing ticket data 2s
          </p>

          <div
            className="absolute bottom-4 left-1/2 -translate-x-1/2 transition-opacity duration-500"
            style={{
              opacity: v(12) ? 1 : 0,
              pointerEvents: v(12) ? "auto" : "none",
            }}
          >
            {/* oxlint-disable-next-line react/forbid-elements */}
            <button
              onClick={handleFixMe}
              className="cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring shadow-sm shadow-black/10 border border-transparent bg-card ring-1 ring-foreground/10 duration-200 hover:bg-muted/50 h-7 px-3.5 flex w-fit select-none"
            >
              Fix this
            </button>
          </div>
        </div>
      )}

      {/* Code section */}
      {phase === "code" && (
        <div
          className="absolute inset-0 flex flex-col"
          style={{ animation: "fadeIn 0.5s cubic-bezier(0.16,1,0.3,1) both" }}
        >
          <p
            className="px-5 pt-4 pb-2 text-[12px] text-foreground/70 leading-relaxed transition-opacity duration-500"
            style={{ opacity: showHeadline ? 1 : 0 }}
          >
            With Executor, run code directly in a sandbox, this is so much
            faster.
          </p>
          <div className="px-5 pb-4">
            <pre className="font-mono text-[11px] leading-[1.7] whitespace-pre overflow-x-auto m-0">
              <code>
                {chars.slice(0, codeChars).map((c, i) => (
                  <span key={i} style={{ color: c.color }}>
                    {c.ch}
                  </span>
                ))}
                {codeChars < chars.length && (
                  <span
                    style={{
                      animation: "cursor-blink 1s steps(1) infinite",
                    }}
                    className="text-muted-foreground"
                  >
                    ▎
                  </span>
                )}
              </code>
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolRow({
  visible,
  checked,
  text,
  meta,
}: {
  visible: boolean;
  checked: boolean;
  text: string;
  meta: string;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-lg bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.04)] px-3 py-2 transition-opacity duration-300"
      style={{ opacity: visible ? 1 : 0 }}
    >
      <svg
        className={`w-[14px] h-[14px] shrink-0 transition-colors duration-200 ${checked ? "text-neutral-400" : "text-neutral-300"}`}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
      >
        <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
        {checked && (
          <polyline
            points="4.5 8 7 10.5 11.5 5.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
      <span className="text-foreground/80">{text}</span>
      <span className="ml-auto text-muted-foreground shrink-0">{meta}</span>
    </div>
  );
}

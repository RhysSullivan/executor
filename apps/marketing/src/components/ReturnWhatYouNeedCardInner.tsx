import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// Pre-computed tokens for the code mode example (github-light theme)
// const bugs = issues
//   .filter(i => i.labels.includes("bug") && i.state === "open")
//   .map(({ id, title, assignee }) => ({ id, title, assignee: assignee.name }))
// return { count: bugs.length, bugs }
// // → { count: 3, bugs: [{ id: "ISS-1291", ... }, ...] }
const CODE_TOKENS: [string, string][][] = [
  [
    ["const", "#D73A49"],
    [" bugs ", "#24292E"],
    ["=", "#D73A49"],
    [" issues", "#24292E"],
  ],
  [
    ["  .", "#24292E"],
    ["filter", "#6F42C1"],
    ["(", "#24292E"],
    ["i", "#E36209"],
    [" ", "#24292E"],
    ["=>", "#D73A49"],
    [" i.labels.", "#24292E"],
    ["includes", "#6F42C1"],
    ["(", "#24292E"],
    ['"bug"', "#032F62"],
    [")", "#24292E"],
    [" && ", "#D73A49"],
    ["i.state ", "#24292E"],
    ["===", "#D73A49"],
    [" ", "#24292E"],
    ['"open"', "#032F62"],
    [")", "#24292E"],
  ],
  [
    ["  .", "#24292E"],
    ["map", "#6F42C1"],
    ["(({ ", "#24292E"],
    ["id", "#E36209"],
    [", ", "#24292E"],
    ["title", "#E36209"],
    [", ", "#24292E"],
    ["assignee", "#E36209"],
    [" }) ", "#24292E"],
    ["=>", "#D73A49"],
  ],
  [["    ({ id, title, assignee: assignee.name })", "#24292E"]],
  [["  )", "#24292E"]],
  [["", "#24292E"]],
  [
    ["return", "#D73A49"],
    [" { count: bugs.length, bugs }", "#24292E"],
  ],
  [["", "#24292E"]],
  [["// → { count: 3, bugs: [", "#6A737D"]],
  [
    [
      '//     { id: "ISS-1291", title: "Fix auth flow", assignee: "Alice" },',
      "#6A737D",
    ],
  ],
  [["//     ... ] }", "#6A737D"]],
];

const JSON_LINES = [
  { indent: 0, content: "{" },
  { indent: 1, content: '"issues": [' },
  { indent: 2, content: '{ "id": "ISS-1291", "title": "Fix auth flow",' },
  { indent: 3, content: '"description": "Users report...",' },
  { indent: 3, content: '"assignee": { "name": "Alice", "email": "..." },' },
  { indent: 3, content: '"labels": ["bug", "auth", "p1"],' },
  { indent: 3, content: '"comments": [{ "body": "...", ... }],' },
  { indent: 3, content: '"history": [...], "attachments": [...] },' },
  { indent: 2, content: '{ "id": "ISS-1292", ... }, ...' },
  { indent: 1, content: "]" },
  { indent: 0, content: "}" },
];

const STEP_DELAYS = [0, 200, 600, 1200, 1800, 2400, 3200];
const TYPE_SPEED = 8;

export default function ReturnWhatYouNeedCardInner() {
  const containerRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const timeouts = useRef<number[]>([]);

  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<"payload" | "fading" | "code">("payload");
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
    timeouts.current = [];

    setStep(0);
    setPhase("payload");
    setCodeChars(0);
    setShowHeadline(false);
    setLockedHeight(undefined);

    for (let i = 1; i < STEP_DELAYS.length; i++) {
      timeouts.current.push(
        window.setTimeout(() => setStep(i), STEP_DELAYS[i]),
      );
    }
  }, []);

  useEffect(
    () => () => {
      timeouts.current.forEach(clearTimeout);
    },
    [],
  );

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

  const handleFix = useCallback(() => {
    if (containerRef.current) {
      setLockedHeight(containerRef.current.offsetHeight);
    }
    setPhase("fading");
    setShowHeadline(true);
    timeouts.current.push(
      window.setTimeout(() => {
        setLockedHeight(undefined);
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

      {/* MCP payload phase */}
      {phase !== "code" && (
        <div
          className="px-5 pt-4 pb-16 relative"
          style={{
            opacity: phase === "fading" ? 0 : 1,
            transition: "opacity 0.4s cubic-bezier(0.16,1,0.3,1)",
          }}
        >
          <div
            className="bg-white rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_0_1px_rgba(0,0,0,0.04)] p-3 font-mono text-[11px] leading-[1.6] text-muted-foreground max-h-[130px] overflow-hidden relative transition-opacity duration-300"
            style={{ opacity: v(2) ? 1 : 0 }}
          >
            {JSON_LINES.map((line, i) => (
              <div
                key={i}
                style={{ paddingLeft: line.indent * 12 }}
                className="transition-opacity duration-200"
              >
                {line.content}
              </div>
            ))}
            <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-white to-transparent" />
          </div>

          <div
            className="mt-2 flex items-center justify-end gap-1.5 transition-opacity duration-300"
            style={{ opacity: v(3) ? 1 : 0 }}
          >
            <span className="text-[12px] font-medium text-destructive">
              ~12,400 tokens
            </span>
          </div>

          <div
            className="absolute bottom-4 left-1/2 -translate-x-1/2 transition-opacity duration-500"
            style={{
              opacity: v(4) ? 1 : 0,
              pointerEvents: v(4) ? "auto" : "none",
            }}
          >
            {/* oxlint-disable-next-line react/forbid-elements */}
            <button
              onClick={handleFix}
              className="cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring shadow-sm shadow-black/10 border border-transparent bg-card ring-1 ring-foreground/10 duration-200 hover:bg-muted/50 h-7 px-3.5 flex w-fit select-none"
            >
              Fix this
            </button>
          </div>
        </div>
      )}

      {/* Code mode phase */}
      {phase === "code" && (
        <div
          className="flex flex-col"
          style={{ animation: "fadeIn 0.5s cubic-bezier(0.16,1,0.3,1) both" }}
        >
          <p
            className="px-5 pt-4 pb-2 text-[12px] text-foreground/70 leading-relaxed transition-opacity duration-500"
            style={{ opacity: showHeadline ? 1 : 0 }}
          >
            With code mode, return only what matters, filter and reshape on the
            server before anything hits the context window.
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

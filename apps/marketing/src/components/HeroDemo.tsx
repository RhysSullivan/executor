import { useRef, useState, useCallback, useEffect } from "react";
import { Terminal, useTerminal } from "@wterm/react";
import "@wterm/react/css";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function typeText(
  write: (d: string) => void,
  text: string,
  speed = 18
) {
  for (const ch of text) {
    write(ch);
    await sleep(speed + Math.random() * 12);
  }
}

// ---------------------------------------------------------------------------
// Draggable hook — direct DOM mutation, no re-renders
// ---------------------------------------------------------------------------

function useDraggable() {
  const elRef = useRef<HTMLDivElement>(null);
  const pos = useRef({ x: 0, y: 0 });
  const off = useRef({ x: 0, y: 0 });
  const active = useRef(false);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-traffic-light]")) return;
    active.current = true;
    setDragging(true);
    off.current = { x: e.clientX - pos.current.x, y: e.clientY - pos.current.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!active.current) return;
    const x = e.clientX - off.current.x;
    const y = e.clientY - off.current.y;
    pos.current = { x, y };
    elRef.current!.style.transform = `translate(${x}px, ${y}px)`;
  }, []);

  const onPointerUp = useCallback(() => {
    active.current = false;
    setDragging(false);
  }, []);

  return { elRef, dragging, onPointerDown, onPointerMove, onPointerUp };
}

// ---------------------------------------------------------------------------
// macOS title bar
// ---------------------------------------------------------------------------

function TitleBar({
  title,
  drag,
}: {
  title: string;
  drag: ReturnType<typeof useDraggable>;
}) {
  return (
    <div
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
      className={`flex items-center gap-2 px-3 py-[6px] bg-gradient-to-b from-[#1a1a1a] to-[#0a0a0a] border-b border-[#222] select-none shrink-0 ${drag.dragging ? "cursor-grabbing" : "cursor-grab"}`}
    >
      <div className="flex items-center gap-[6px]" data-traffic-light>
        <div className="w-[10px] h-[10px] rounded-full bg-[#ff5f57] shadow-[inset_0_-0.5px_0.5px_rgba(0,0,0,0.15)]" />
        <div className="w-[10px] h-[10px] rounded-full bg-[#febc2e] shadow-[inset_0_-0.5px_0.5px_rgba(0,0,0,0.15)]" />
        <div className="w-[10px] h-[10px] rounded-full bg-[#28c840] shadow-[inset_0_-0.5px_0.5px_rgba(0,0,0,0.15)]" />
      </div>
      <span className="flex-1 text-center text-[11px] text-[#9a9a9a] -ml-[46px]">
        {title}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sources browser panel
// ---------------------------------------------------------------------------

interface Source {
  name: string;
  kind: string;
  tools: number;
  favicon: string;
}

function SourcesPanel({
  sources,
  visible,
  drag,
}: {
  sources: Source[];
  visible: boolean;
  drag: ReturnType<typeof useDraggable>;
}) {
  return (
    <div
      ref={drag.elRef}
      className={`absolute right-0 top-0 flex flex-col rounded-lg bg-[#000] shadow-[0_8px_60px_rgba(0,0,0,0.18)] border border-[#333] overflow-hidden transition-opacity duration-500 ${visible ? "opacity-100" : "opacity-0 pointer-events-none"}`}
      style={{ width: "calc(40% - 8px)", height: 420 }}
    >
      {/* Browser title bar with URL */}
      <div
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        className={`flex items-center gap-2 px-3 py-[6px] bg-gradient-to-b from-[#1a1a1a] to-[#0a0a0a] border-b border-[#222] select-none shrink-0 ${drag.dragging ? "cursor-grabbing" : "cursor-grab"}`}
      >
        <div className="flex items-center gap-[6px]" data-traffic-light>
          <div className="w-[10px] h-[10px] rounded-full bg-[#ff5f57] shadow-[inset_0_-0.5px_0.5px_rgba(0,0,0,0.15)]" />
          <div className="w-[10px] h-[10px] rounded-full bg-[#febc2e] shadow-[inset_0_-0.5px_0.5px_rgba(0,0,0,0.15)]" />
          <div className="w-[10px] h-[10px] rounded-full bg-[#28c840] shadow-[inset_0_-0.5px_0.5px_rgba(0,0,0,0.15)]" />
        </div>
        <div className="flex-1 mx-2">
          <div className="bg-[#1a1a1a] rounded-md px-3 py-[3px] text-[11px] text-[#888] text-center border border-[#2a2a2a]">
            localhost:4788
          </div>
        </div>
      </div>

      {/* Executor banner */}
      <div className="px-4 pt-4 pb-3 border-b border-[#222]">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold tracking-[-0.02em] text-[#eee]">Ξxecutor</span>
          <span className="text-[10px] text-[#555] bg-[#1a1a1a] px-1.5 py-0.5 rounded">local</span>
        </div>
        <span className="text-[11px] text-[#555] mt-0.5 block">http://localhost:4788</span>
      </div>

      {/* Content */}
      <div className="flex-1 p-4 overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <span className="text-[13px] font-medium text-[#eee]">Sources</span>
          <span className="text-[11px] text-[#555]">{sources.length} connected</span>
        </div>

        {sources.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-[#444]">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="text-[12px] mt-2">No sources connected</span>
          </div>
        )}

        <div className="flex flex-col gap-2">
          {sources.map((s, i) => (
            <div
              key={i}
              className="flex items-center gap-3 p-3 rounded-lg bg-[#111] border border-[#222] animate-[fadeIn_0.3s_ease]"
            >
              <img
                src={s.favicon}
                alt=""
                className="w-6 h-6 rounded"
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-[#eee] truncate">{s.name}</div>
                <div className="text-[11px] text-[#666]">{s.kind} &middot; {s.tools} tools</div>
              </div>
              <div className="w-2 h-2 rounded-full bg-[#28c840]" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main HeroDemo
// ---------------------------------------------------------------------------

export default function HeroDemo() {
  const { ref, write, focus } = useTerminal();
  const lineBuffer = useRef("");
  const demoStarted = useRef(false);

  const termDrag = useDraggable();
  const browserDrag = useDraggable();

  const [playing, setPlaying] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [sources, setSources] = useState<Source[]>([]);

  // Scroll the terminal element to the bottom after the next paint
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = (ref.current as any)?.instance?.element as HTMLElement | undefined;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [ref]);

  // Run the scripted demo
  const runDemo = useCallback(async () => {
    demoStarted.current = true;
    setPlaying(true);

    // Step 1: executor web
    write("$ ");
    await typeText(write, "npx executor web");
    write("\r\n");
    await sleep(400);
    write("\r\n");
    write("\x1b[90mExecutor is ready.\x1b[0m\r\n");
    write("\x1b[90mWeb:     http://localhost:4788\x1b[0m\r\n");
    write("\x1b[90mMCP:     http://localhost:4788/mcp\x1b[0m\r\n");
    write("\x1b[90mOpenAPI: http://localhost:4788/api/docs\x1b[0m\r\n");
    scrollToBottom();
    await sleep(600);
    setShowBrowser(true);
    await sleep(1000);

    // Step 2: add Vercel OpenAPI source
    write("\r\n$ ");
    await typeText(write, 'executor call \'await tools.openapi.addSource({ spec: "https://openapi.vercel.sh" })\'');
    scrollToBottom();
    write("\r\n");
    await sleep(800);
    write("\r\n");
    write("\x1b[32m✓\x1b[0m Added source \x1b[1mvercel\x1b[0m (OpenAPI)\r\n");
    write("\x1b[90m  58 operations registered\x1b[0m\r\n");
    scrollToBottom();
    await sleep(400);
    setSources([
      {
        name: "Vercel API",
        kind: "OpenAPI",
        tools: 58,
        favicon: "https://assets.vercel.com/image/upload/front/favicon/vercel/favicon.ico",
      },
    ]);
    await sleep(1200);

    // Step 3: add GitHub OpenAPI source
    write("\r\n$ ");
    await typeText(write, 'executor call \'await tools.openapi.addSource({ spec: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json" })\'');
    scrollToBottom();
    write("\r\n");
    await sleep(800);
    write("\r\n");
    write("\x1b[32m✓\x1b[0m Added source \x1b[1mgithub\x1b[0m (OpenAPI)\r\n");
    write("\x1b[90m  935 operations registered\x1b[0m\r\n");
    scrollToBottom();
    await sleep(400);
    setSources([
      {
        name: "Vercel API",
        kind: "OpenAPI",
        tools: 58,
        favicon: "https://assets.vercel.com/image/upload/front/favicon/vercel/favicon.ico",
      },
      {
        name: "GitHub API",
        kind: "OpenAPI",
        tools: 935,
        favicon: "https://github.githubassets.com/favicons/favicon-dark.svg",
      },
    ]);
    await sleep(1200);

    // Step 4: add-mcp
    write("\r\n$ ");
    await typeText(write, 'npx add-mcp "executor mcp" --name "executor"');
    scrollToBottom();
    write("\r\n");
    await sleep(600);
    write("\r\n");
    write("\x1b[32m✓\x1b[0m Added MCP server \x1b[1mexecutor\x1b[0m to Claude config\r\n");
    write("\x1b[90m  993 tools available via MCP\x1b[0m\r\n");
    scrollToBottom();
    await sleep(1200);

    // Step 5: AI query via claude -p
    write("\r\n$ ");
    await typeText(write, 'claude -p "Why did my deployment fail?"');
    scrollToBottom();
    write("\r\n");
    await sleep(600);
    write("\r\n");

    const aiLines = [
      "\x1b[36m◆\x1b[0m Investigating deployment failure...\r\n",
      "\x1b[90m  → vercel.deployments.list({ limit: 5 })\x1b[0m\r\n",
      "\x1b[90m  → vercel.deployments.get({ id: \"dpl_7kR2x...\" })\x1b[0m\r\n",
      "\x1b[90m  → github.repos.getCommit({ ref: \"abc1234\" })\x1b[0m\r\n",
      "\x1b[90m  → github.pulls.list({ state: \"merged\", per_page: 5 })\x1b[0m\r\n",
      "\r\n",
      "\x1b[1mYour latest deployment failed during the build step:\x1b[0m\r\n",
      "\r\n",
      "  \x1b[31mError:\x1b[0m Module not found: Can't resolve '@/lib/db'\r\n",
      "  \x1b[90min\x1b[0m src/app/api/users/route.ts:3\r\n",
      "\r\n",
      "\x1b[90mPR\x1b[0m #142 \x1b[90m(\x1b[0mrefactor: rename database modules\x1b[90m) renamed\x1b[0m\r\n",
      "lib/db.ts \x1b[90m→\x1b[0m lib/database.ts \x1b[90mbut missed the import in\x1b[0m route.ts\x1b[90m.\x1b[0m\r\n",
    ];

    for (const line of aiLines) {
      write(line);
      scrollToBottom();
      await sleep(200 + Math.random() * 200);
    }

    await sleep(400);
    write("\r\n$ ");
    scrollToBottom();
    focus();
  }, [write, focus, scrollToBottom]);

  // Interactive shell — also handles the initial "start the demo" trigger
  const handleData = useCallback(
    (data: string) => {
      if (!demoStarted.current) {
        if (data === "\r") {
          write("\x1b[2J\x1b[H");
          runDemo();
        }
        return;
      }
      if (data === "\r") {
        const cmd = lineBuffer.current.trim();
        lineBuffer.current = "";
        write("\r\n");
        if (cmd === "help") {
          write("\x1b[90mAvailable commands: executor web, executor call, help, clear\x1b[0m\r\n");
        } else if (cmd === "clear") {
          write("\x1b[2J\x1b[H");
        } else if (cmd) {
          write(`\x1b[90mcommand not found: ${cmd}\x1b[0m\r\n`);
        }
        write("$ ");
        return;
      }
      if (data === "\x7f") {
        if (lineBuffer.current.length > 0) {
          lineBuffer.current = lineBuffer.current.slice(0, -1);
          write("\b \b");
        }
        return;
      }
      if (data < " " && data !== "\t") return;
      lineBuffer.current += data;
      write(data);
    },
    [write, runDemo]
  );

  // Show a static prompt — demo starts when the user presses Enter
  useEffect(() => {
    if (!ref.current || demoStarted.current) return;
    const t = setTimeout(() => {
      write("$ start the demo ");
    }, 500);
    return () => clearTimeout(t);
  }, [ref, write]);

  return (
    <div className="relative" style={{ height: 420 }}>
      {/* Terminal window — 60% */}
      <div
        ref={termDrag.elRef}
        className="absolute left-0 top-0 flex flex-col rounded-lg bg-[#000] shadow-[0_8px_60px_rgba(0,0,0,0.18)] border border-[#333] overflow-hidden"
        style={{ height: 420, width: showBrowser ? "calc(60% - 8px)" : "100%", transition: "width 0.5s ease" }}
      >
        <TitleBar title="Terminal" drag={termDrag} />
        <div className={`flex-1 min-h-0${playing ? '' : ' slow-cursor-blink'}`}>
          <Terminal
            ref={ref}
            autoResize
            cursorBlink
            theme="vercel"
            onData={handleData}
            style={{ height: '100%', padding: '0 12px', overflowY: playing ? 'auto' : 'hidden' }}
          />
        </div>
      </div>

      {/* Sources browser panel — 40% */}
      <SourcesPanel sources={sources} visible={showBrowser} drag={browserDrag} />
    </div>
  );
}

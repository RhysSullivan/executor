import { useRef, useState, useCallback, useEffect } from "react";
import { Terminal, useTerminal } from "@wterm/react";
import "@wterm/react/css";

export default function TerminalWindow() {
  const { ref, write, focus } = useTerminal();
  const dragRef = useRef<HTMLDivElement>(null);
  const posRef = useRef({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [started, setStarted] = useState(false);
  const offset = useRef({ x: 0, y: 0 });
  const lineBuffer = useRef("");

  const onDragDown = useCallback(
    (e: React.PointerEvent) => {
      if ((e.target as HTMLElement).closest("[data-traffic-light]")) return;
      setDragging(true);
      offset.current = {
        x: e.clientX - posRef.current.x,
        y: e.clientY - posRef.current.y,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    []
  );

  const onDragMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const x = e.clientX - offset.current.x;
      const y = e.clientY - offset.current.y;
      posRef.current = { x, y };
      dragRef.current!.style.transform = `translate(${x}px, ${y}px)`;
    },
    [dragging]
  );

  const onDragUp = useCallback(() => setDragging(false), []);

  const handleData = useCallback(
    (data: string) => {
      if (data === "\r") {
        const cmd = lineBuffer.current.trim();
        lineBuffer.current = "";
        write("\r\n");
        if (cmd === "executor serve") {
          write("\x1b[90m● MCP server running on stdio\x1b[0m\r\n");
          write("\x1b[90m● 42 tools loaded from 3 plugins\x1b[0m\r\n");
          write("\x1b[90m● Ready for connections\x1b[0m\r\n");
        } else if (cmd === "help") {
          write("\x1b[90mAvailable commands: executor serve, help, clear\x1b[0m\r\n");
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
    [write]
  );

  useEffect(() => {
    if (!ref.current) return;
    const t = setTimeout(() => {
      write("$ ");
      focus();
      setStarted(true);
    }, 800);
    return () => clearTimeout(t);
  }, [ref, write, focus]);

  return (
    <div
      ref={dragRef}
      className="relative flex flex-col rounded-lg bg-[#000000] shadow-[0_8px_60px_rgba(0,0,0,0.18),0_2px_12px_rgba(0,0,0,0.12)] border border-[#333333] overflow-hidden"
      style={{ width: 560, minHeight: 200 }}
    >
      {/* Title bar */}
      <div
        onPointerDown={onDragDown}
        onPointerMove={onDragMove}
        onPointerUp={onDragUp}
        className={`flex items-center gap-2 px-3 py-[6px] bg-gradient-to-b from-[#1a1a1a] to-[#0a0a0a] border-b border-[#222222] select-none ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
      >
        <div className="flex items-center gap-[6px]" data-traffic-light>
          <div className="w-[10px] h-[10px] rounded-full bg-[#ff5f57] shadow-[inset_0_-0.5px_0.5px_rgba(0,0,0,0.15)]" />
          <div className="w-[10px] h-[10px] rounded-full bg-[#febc2e] shadow-[inset_0_-0.5px_0.5px_rgba(0,0,0,0.15)]" />
          <div className="w-[10px] h-[10px] rounded-full bg-[#28c840] shadow-[inset_0_-0.5px_0.5px_rgba(0,0,0,0.15)]" />
        </div>
        <span className="flex-1 text-center text-[11px] text-[#9a9a9a] -ml-[46px]">
          Terminal
        </span>
      </div>

      {/* Terminal — flush to edges */}
      <div className="flex-1 min-h-0 relative">
        <Terminal
          ref={ref}
          autoResize
          theme="vercel"
          onData={handleData}
        />
        {!started && (
          <span
            className="absolute animate-slow-blink"
            style={{
              top: 12,
              left: 12,
              width: "1ch",
              height: "var(--term-row-height, 17px)",
              background: "#eeeeee",
              fontFamily: "'Menlo', 'Consolas', 'DejaVu Sans Mono', 'Courier New', monospace",
              fontSize: 14,
              lineHeight: 1.2,
              pointerEvents: "none",
            }}
          />
        )}
      </div>
    </div>
  );
}

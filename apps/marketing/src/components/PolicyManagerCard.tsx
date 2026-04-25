import { useEffect, useRef, useState } from "react";

type Policy = "deny" | "read" | "write";

const policies: { pattern: string; priority: number; default: Policy }[] = [
  { pattern: "linear.*", priority: 10, default: "write" },
  { pattern: "stripe.*", priority: 10, default: "read" },
  { pattern: "gmail.send_email", priority: 20, default: "write" },
  { pattern: "*.delete", priority: 100, default: "deny" },
];

const options: { value: Policy; label: string }[] = [
  { value: "deny", label: "Deny" },
  { value: "read", label: "Read" },
  { value: "write", label: "Write" },
];

const securityEmojis = [
  "🔓", "💀", "🚨", "⚠️", "🔥", "💣", "🧨", "☠️", "🏴‍☠️", "👾",
  "🐛", "🕵️", "🔑", "🗝️", "🛡️", "⛔", "🚫", "❌", "🆘", "📛",
];

interface Particle {
  id: number;
  emoji: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotationSpeed: number;
  scale: number;
  opacity: number;
}

function EmojiExplosion({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const overlay = overlayRef.current;
    const container = containerRef.current;
    if (!overlay || !container) return;

    const rect = container.getBoundingClientRect();
    const ox = rect.left;
    const oy = rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    const particles: Particle[] = Array.from({ length: 80 }, (_, i) => {
      const angle = (Math.PI * 2 * i) / 80 + (Math.random() - 0.5) * 1.2;
      const speed = 2 + Math.random() * 7;
      return {
        id: i,
        emoji: securityEmojis[Math.floor(Math.random() * securityEmojis.length)]!,
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed * (0.8 + Math.random() * 0.6),
        vy: Math.sin(angle) * speed * (0.8 + Math.random() * 0.6) - Math.random() * 2,
        rotation: Math.random() * 360,
        rotationSpeed: (Math.random() - 0.5) * 15,
        scale: 0.8 + Math.random() * 1.4,
        opacity: 1,
      };
    });

    const els: HTMLSpanElement[] = particles.map((p) => {
      const el = document.createElement("span");
      el.textContent = p.emoji;
      el.style.position = "absolute";
      el.style.left = "0";
      el.style.top = "0";
      el.style.fontSize = `${1.2 + p.scale * 0.5}rem`;
      el.style.willChange = "transform, opacity";
      el.style.pointerEvents = "none";
      el.style.userSelect = "none";
      overlay.appendChild(el);
      return el;
    });

    let frame = 0;
    let animId = 0;

    const animate = () => {
      frame++;
      let alive = 0;

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i]!;
        const el = els[i]!;

        p.vy += 0.08;
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.998;
        p.rotation += p.rotationSpeed;
        p.rotationSpeed *= 0.997;

        if (frame > 120) {
          p.opacity = Math.max(0, p.opacity - 0.008);
        }

        if (p.opacity <= 0) {
          el.style.display = "none";
          continue;
        }

        alive++;

        // layered bounce: slow breathe + fast jitter + elastic squash
        const breathe = Math.sin(frame * 0.08 + p.id * 0.7) * 0.25;
        const jitter = Math.sin(frame * 0.4 + p.id * 2.3) * 0.15;
        const elastic = Math.exp(-frame * 0.012) * Math.sin(frame * 0.2 + p.id) * 0.4;
        const s = p.scale * (1 + breathe + jitter + elastic);

        // squash & stretch: scale x/y independently for a rubbery feel
        const squashPhase = Math.sin(frame * 0.15 + p.id * 1.1);
        const sx = s * (1 + squashPhase * 0.15);
        const sy = s * (1 - squashPhase * 0.15);

        el.style.transform = `translate3d(${ox + p.x}px, ${oy + p.y}px, 0) rotate(${p.rotation}deg) scale(${sx}, ${sy})`;
        el.style.opacity = String(p.opacity);
      }

      if (alive > 0 && frame < 400) {
        animId = requestAnimationFrame(animate);
      } else {
        overlay.innerHTML = "";
      }
    };

    animId = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(animId);
      overlay.innerHTML = "";
    };
  }, [containerRef]);

  return <div ref={overlayRef} className="fixed inset-0 pointer-events-none z-50" />;
}

export default function PolicyManagerCard() {
  const [values, setValues] = useState<Policy[]>(
    policies.map((p) => p.default)
  );
  const [explosionKey, setExplosionKey] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const prevAllWrite = useRef(false);

  const allWrite = values.every((v) => v === "write");

  useEffect(() => {
    if (allWrite && !prevAllWrite.current) {
      setExplosionKey(Date.now());
      const timeout = setTimeout(() => setExplosionKey(null), 7000);
      prevAllWrite.current = true;
      return () => clearTimeout(timeout);
    }
    if (!allWrite) {
      prevAllWrite.current = false;
    }
  }, [allWrite]);

  return (
    <div ref={containerRef} className="relative">
      {explosionKey !== null && <EmojiExplosion key={explosionKey} containerRef={containerRef} />}
      <div className="px-4 py-3 text-[13px] font-medium text-foreground">
        Active policies
      </div>
      <div className="border-t border-border divide-y divide-border">
        {policies.map((policy, i) => (
          <div
            key={policy.pattern}
            className="flex items-center justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0 flex flex-col gap-0.5">
              <span className="text-[13px] font-medium font-mono text-foreground truncate">
                {policy.pattern}
              </span>
              <span className="text-[11px] text-muted-foreground truncate">
                Priority {policy.priority}
              </span>
            </div>
            <div className="flex items-center bg-muted rounded-lg p-0.5 shrink-0">
              {options.map((opt) => {
                const selected = values[i] === opt.value;
                // oxlint-disable-next-line react/forbid-elements
                return (<button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      setValues((prev) => {
                        const next = [...prev];
                        next[i] = opt.value;
                        return next;
                      })
                    }
                    className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-all cursor-pointer ${
                      selected
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

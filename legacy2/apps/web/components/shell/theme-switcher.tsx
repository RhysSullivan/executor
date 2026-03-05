"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";

import { cn } from "../../lib/utils";

type ThemeOption = {
  value: "system" | "light" | "dark";
  label: string;
  icon: React.ReactNode;
};

const OPTIONS: ReadonlyArray<ThemeOption> = [
  {
    value: "system",
    label: "System",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
        <rect x="2" y="3" width="12" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.2" />
        <path d="M6 13h4M8 11v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    value: "light",
    label: "Light",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
        <circle cx="8" cy="8" r="2.8" stroke="currentColor" strokeWidth="1.2" />
        <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.2 3.2l1.4 1.4M11.4 11.4l1.4 1.4M12.8 3.2l-1.4 1.4M4.6 11.4l-1.4 1.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
        <path d="M10.8 2.2a5.8 5.8 0 102.9 10.9 6.2 6.2 0 11-2.9-10.9z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="h-7" aria-hidden />;
  }

  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-sidebar-border bg-sidebar-active/40 p-0.5">
      {OPTIONS.map((option) => {
        const active = theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => setTheme(option.value)}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-1 text-[11px] transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-sidebar-foreground/70 hover:text-sidebar-foreground",
            )}
            title={option.label}
          >
            {option.icon}
            <span className="sr-only sm:not-sr-only">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

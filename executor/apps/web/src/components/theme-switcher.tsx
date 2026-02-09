"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const options = [
    { value: "system", icon: Monitor, label: "System" },
    { value: "light", icon: Sun, label: "Light" },
    { value: "dark", icon: Moon, label: "Dark" },
  ] as const;

  return (
    <div className="flex items-center gap-0.5 rounded-full border border-border bg-muted/50 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => setTheme(option.value)}
          className={cn(
            "rounded-full p-1.5 transition-colors",
            mounted && theme === option.value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          title={option.label}
        >
          <option.icon className="h-3.5 w-3.5" />
          <span className="sr-only">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

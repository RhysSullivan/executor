import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ReadonlyArray<ClassValue>): string {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Shared ID generation
// ---------------------------------------------------------------------------

export const createLocalId = (prefix: string): string => {
  const randomPart =
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}${randomPart}`;
};

// ---------------------------------------------------------------------------
// Shared timestamp formatting
// ---------------------------------------------------------------------------

const timestampFormatter = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export const formatTimestamp = (value: number | null): string => {
  if (value === null) return "-";
  return timestampFormatter.format(new Date(value));
};

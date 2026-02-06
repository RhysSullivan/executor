import { generateObject } from "ai";
import { createClaudeCode } from "ai-sdk-provider-claude-code";
import { z } from "zod";

export interface GeneratedCode {
  code: string;
  rationale: string;
  provider: "claude" | "heuristic";
}

interface CodegenOptions {
  now?: Date;
  provider?: "claude" | "heuristic";
  generateWithClaude?: (params: { prompt: string; now: Date }) => Promise<{ code: string; rationale: string }>;
}

const DEFAULT_PROVIDER = resolveDefaultProvider();
const DEFAULT_CLAUDE_MODEL = readEnv("OPENASSISTANT_CLAUDE_MODEL")?.trim() || "sonnet";
const CLAUDE_TIMEOUT_MS = Number(readEnv("OPENASSISTANT_CLAUDE_TIMEOUT_MS") ?? 30_000);
const CLAUDE_PATH = readEnv("OPENASSISTANT_CLAUDE_PATH")?.trim();
const CODEGEN_SCHEMA = z.object({
  code: z.string().min(1),
  rationale: z.string().min(1),
});

const claudeCode = createClaudeCode({
  defaultSettings: {
    permissionMode: "dontAsk",
    tools: [],
    maxTurns: 1,
    ...(CLAUDE_PATH ? { pathToClaudeCodeExecutable: CLAUDE_PATH } : {}),
  },
});

export async function generateCodeFromPrompt(
  prompt: string,
  options: CodegenOptions = {},
): Promise<GeneratedCode> {
  const now = options.now ?? new Date();
  const provider = options.provider ?? DEFAULT_PROVIDER;

  if (provider === "claude") {
    try {
      const generated = await (options.generateWithClaude ?? generateWithClaude)({
        prompt,
        now,
      });
      return { ...generated, provider: "claude" };
    } catch (error) {
      const fallback = generateHeuristic(prompt, now);
      return {
        ...fallback,
        provider: "heuristic",
        rationale: `${fallback.rationale} Claude fallback: ${describeUnknown(error)}`,
      };
    }
  }

  const generated = generateHeuristic(prompt, now);
  return { ...generated, provider: "heuristic" };
}

async function generateWithClaude(params: {
  prompt: string;
  now: Date;
}): Promise<Omit<GeneratedCode, "provider">> {
  const { prompt, now } = params;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CLAUDE_TIMEOUT_MS);
  try {
    const result = await generateObject({
      model: claudeCode(DEFAULT_CLAUDE_MODEL),
      schema: CODEGEN_SCHEMA,
      prompt: buildPlannerPrompt(prompt, now),
      temperature: 0,
      abortSignal: abortController.signal,
    });

    return result.object;
  } finally {
    clearTimeout(timeout);
  }
}

function buildPlannerPrompt(userPrompt: string, now: Date): string {
  return [
    "You are a code generator for a Bun TypeScript codemode runner.",
    "Return a function body only (no markdown, no fences, no explanations in code).",
    "The runtime invokes: new AsyncFunction('tools', code).",
    "Available tools:",
    "- await tools.calendar.update({ title: string, startsAt: string, notes?: string })",
    "- await tools.calendar.list()",
    "Rules:",
    "- Use await for tool calls.",
    "- If request implies creating/updating a calendar event, call tools.calendar.update.",
    "- startsAt must be an ISO-8601 string.",
    "- If time/date missing, use current timestamp.",
    "- Always return a final object (e.g. { message, event }).",
    `Current timestamp: ${now.toISOString()}`,
    `User request: ${userPrompt}`,
  ].join("\n");
}

function resolveDefaultProvider(): "claude" | "heuristic" {
  const configured = readEnv("OPENASSISTANT_CODEGEN_PROVIDER")?.trim().toLowerCase();
  if (configured === "heuristic") {
    return "heuristic";
  }
  return "claude";
}

function generateHeuristic(prompt: string, now: Date): Omit<GeneratedCode, "provider"> {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return {
      code: "return { message: 'Empty prompt.' };",
      rationale: "Empty prompt fallback.",
    };
  }

  if (trimmed.toLowerCase().startsWith("code:")) {
    return {
      code: trimmed.slice(5).trim(),
      rationale: "User provided direct code.",
    };
  }

  const lower = trimmed.toLowerCase();
  if (lower.includes("calendar") || lower.includes("event") || lower.includes("schedule")) {
    const updates = extractCalendarUpdates(trimmed, now);
    if (updates.length > 0) {
      const code = buildCalendarCode(updates);
      return {
        code,
        rationale:
          updates.length === 1
            ? "Mapped prompt to calendar.update tool call."
            : `Mapped prompt to ${updates.length} calendar.update tool calls.`,
      };
    }
  }

  return {
    code: `return { message: "No tool mapping yet for prompt", prompt: ${JSON.stringify(trimmed)} };`,
    rationale: "Fallback response when no tool intent is detected.",
  };
}

function inferTitle(prompt: string): string {
  const match = prompt.match(
    /(?:put|add|create)\s+(?:an?\s+)?(?:calendar\s+)?(?:event\s+)?(?:to\s+)?(.+?)(?:\s+at\s+|$)/i,
  );
  if (match?.[1]) {
    return cleanTitle(match[1]);
  }
  return "Untitled event";
}

function cleanTitle(input: string): string {
  return input.replace(/^my\s+/i, "").replace(/^calendar\s+/i, "").trim();
}

function inferStartTime(prompt: string, now: Date): string {
  const time = prompt.match(/(?:\bat\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!time) {
    return now.toISOString();
  }

  const dayToken = prompt.match(
    /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  )?.[1];
  return resolveStartsAt(now, Number(time[1]), time[2] ? Number(time[2]) : 0, time[3], dayToken);
}

function describeUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function readEnv(key: string): string | undefined {
  const bun = (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun;
  return bun?.env?.[key] ?? process.env[key];
}

type CalendarUpdateInput = {
  title: string;
  startsAt: string;
  notes: string;
};

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function buildCalendarCode(updates: CalendarUpdateInput[]): string {
  const lines: string[] = ["const events = [];"];
  for (const update of updates) {
    lines.push(`events.push(await tools.calendar.update(${JSON.stringify(update)}));`);
  }
  lines.push('return { message: "Calendar updated", events };');
  return lines.join(" ");
}

function extractCalendarUpdates(prompt: string, now: Date): CalendarUpdateInput[] {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const updates: CalendarUpdateInput[] = [];
  for (const line of lines) {
    if (isInstructionLine(line)) {
      continue;
    }
    const parsed = parseCalendarLine(line, now, prompt);
    if (parsed) {
      updates.push(parsed);
    }
  }

  if (updates.length > 0) {
    return updates;
  }

  return [
    {
      title: inferTitle(prompt),
      startsAt: inferStartTime(prompt, now),
      notes: `Requested via Discord prompt: ${prompt}`,
    },
  ];
}

function isInstructionLine(line: string): boolean {
  const value = line.toLowerCase();
  if (value.includes("calendar") && (value.includes("add") || value.includes("following"))) {
    return true;
  }
  return value.startsWith("please ");
}

function parseCalendarLine(
  rawLine: string,
  now: Date,
  fullPrompt: string,
): CalendarUpdateInput | null {
  const line = rawLine.replace(/^[-*]\s*/, "").replace(/^\d+[.)]\s*/, "").trim();
  const match = line.match(
    /^(?<title>.+?)\s+(?:at\s+)?(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)\b(?:\s+(?<day>today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday))?$/i,
  );

  if (!match?.groups) {
    return null;
  }

  const titleRaw = match.groups.title;
  const hourRaw = match.groups.hour;
  const meridiemRaw = match.groups.meridiem;
  if (!titleRaw || !hourRaw || !meridiemRaw) {
    return null;
  }

  const title = cleanTitle(titleRaw);
  if (!title) {
    return null;
  }

  const hour = Number(hourRaw);
  const minute = match.groups.minute ? Number(match.groups.minute) : 0;
  const meridiem = meridiemRaw;
  const dayToken = match.groups.day;
  const startsAt = resolveStartsAt(now, hour, minute, meridiem, dayToken);

  return {
    title,
    startsAt,
    notes: `Requested via Discord prompt: ${fullPrompt}`,
  };
}

function resolveStartsAt(
  now: Date,
  hour12: number,
  minute: number,
  meridiemRaw: string | undefined,
  dayTokenRaw: string | undefined,
): string {
  const meridiem = meridiemRaw?.toLowerCase();
  const dayToken = dayTokenRaw?.toLowerCase();
  let hour = hour12;

  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  } else if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  const date = new Date(now);
  if (dayToken === "tomorrow") {
    date.setDate(date.getDate() + 1);
  } else if (dayToken) {
    const target = WEEKDAY_INDEX[dayToken];
    if (target === undefined) {
      date.setHours(hour, minute, 0, 0);
      return date.toISOString();
    }
    const current = date.getDay();
    const delta = (target - current + 7) % 7;
    date.setDate(date.getDate() + delta);
  }

  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

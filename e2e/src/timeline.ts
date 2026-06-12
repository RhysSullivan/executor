// The run's focus timeline: which window the scenario was acting on, when.
//
// Focus is DERIVED, never declared — driving a Playwright page focuses the
// browser window; pushing a chat/terminal event focuses the terminal. The
// surfaces call markFocus as a side effect of normal operations, so any
// scenario gets a faithful "where was the developer looking" track for
// free, and scripts/film.ts can cut the session recordings exactly where
// the action moved. Anchors map wall-clock to each recording's own clock.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type TimelineWindow = "terminal" | "browser";

export interface Timeline {
  /** Wall-clock ms when each recording's clock started. */
  readonly anchors: { terminal?: number; browser?: number };
  /** Focus transitions (first event per contiguous run of a window). */
  readonly focus: Array<{ at: number; window: TimelineWindow }>;
  /** Main-frame navigations — lets the viewer render a live URL bar. */
  readonly nav?: Array<{ at: number; url: string }>;
}

const fileFor = (runDir: string) => join(runDir, "timeline.json");

const read = (runDir: string): Timeline => {
  const file = fileFor(runDir);
  if (!existsSync(file)) return { anchors: {}, focus: [] };
  return JSON.parse(readFileSync(file, "utf8")) as Timeline;
};

const write = (runDir: string, timeline: Timeline) =>
  writeFileSync(fileFor(runDir), JSON.stringify(timeline, null, 1));

/** Record that `window`'s recording clock starts now. */
export const markRecordingStart = (runDir: string, window: TimelineWindow): void => {
  const timeline = read(runDir);
  write(runDir, {
    ...timeline,
    anchors: { ...timeline.anchors, [window]: Date.now() },
  });
};

/** Record that the scenario is acting on `window` (deduped per run). */
export const markFocus = (runDir: string, window: TimelineWindow): void => {
  const timeline = read(runDir);
  if (timeline.focus.at(-1)?.window === window) return;
  timeline.focus.push({ at: Date.now(), window });
  write(runDir, timeline);
};

/** Record a main-frame navigation (deduped against the previous URL). */
export const markNavigation = (runDir: string, url: string): void => {
  const timeline = read(runDir);
  const nav = timeline.nav ?? [];
  if (nav.at(-1)?.url === url) return;
  write(runDir, { ...timeline, nav: [...nav, { at: Date.now(), url }] });
};

export const readTimeline = (runDir: string): Timeline | null =>
  existsSync(fileFor(runDir)) ? read(runDir) : null;

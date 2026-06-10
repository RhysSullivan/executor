// Browser surface: Playwright over the target's real web UI, dark mode, with
// the standard debugging artifacts — a Playwright trace (time-travel DOM,
// network, console), the session video (transcoded to mp4 so it plays
// everywhere), per-step screenshots, and a failure screenshot. The scenario
// drives `page` directly; assertions are vitest's job.
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";
import { chromium, type Page } from "playwright";

import type { Identity, Target } from "../target";

export interface BrowserSession {
  readonly page: Page;
  /** Perform one user-visible step; names the trace group + saves a screenshot. */
  readonly step: (label: string, action: (page: Page) => Promise<void>) => Promise<void>;
}

export interface BrowserSurface {
  readonly session: (
    identity: Identity,
    drive: (session: BrowserSession) => Promise<void>,
  ) => Effect.Effect<void>;
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

// acquireUseRelease so a vitest timeout (fiber interruption) still closes the
// browser and flushes video + trace — a bare promise would leak Chromium.
export const makeBrowserSurface = (dir: string, target: Target): BrowserSurface => ({
  session: (identity, drive) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const videoTmp = join(dir, ".video-tmp");
        mkdirSync(videoTmp, { recursive: true });

        const browser = await chromium.launch();
        const context = await browser.newContext({
          colorScheme: "dark",
          viewport: { width: 1280, height: 800 },
          recordVideo: { dir: videoTmp, size: { width: 1280, height: 800 } },
          baseURL: target.baseUrl,
        });
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        if (identity.cookies?.length) {
          await context.addCookies(
            identity.cookies.map((cookie) => ({ ...cookie, url: target.baseUrl })),
          );
        }
        const page = await context.newPage();
        return { browser, context, page, videoTmp, shots: { count: 0 } };
      }),
      ({ page, context, shots }) =>
        Effect.promise(async () => {
          const step = async (label: string, action: (page: Page) => Promise<void>) => {
            await context.tracing.group(label);
            try {
              await action(page);
            } finally {
              await context.tracing.groupEnd();
            }
            await page.screenshot({
              path: join(dir, `${String(shots.count++).padStart(2, "0")}-${slug(label)}.png`),
            });
          };
          try {
            await drive({ page, step });
          } catch (error) {
            // Freeze the scene: the artifact dir shows the screen at failure.
            await page.screenshot({ path: join(dir, "failure.png") }).catch(() => {});
            throw error;
          }
        }),
      ({ browser, context, page, videoTmp }) =>
        Effect.promise(async () => {
          await context.tracing.stop({ path: join(dir, "trace.zip") }).catch(() => {});
          const video = page.video();
          await context.close(); // flushes the recording
          await browser.close();
          const recordedPath = await video?.path().catch(() => undefined);
          if (recordedPath) {
            try {
              // mp4 plays everywhere (Safari/iOS don't do webm).
              await promisify(execFile)("ffmpeg", [
                "-y",
                "-i",
                recordedPath,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "26",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                join(dir, "session.mp4"),
              ]);
            } catch {
              copyFileSync(recordedPath, join(dir, "session.webm"));
            }
          }
          rmSync(videoTmp, { recursive: true, force: true });
        }),
    ),
});

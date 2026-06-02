import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Regression guard: the cloud SPA must HYDRATE in a real browser.
//
// Motivating failure — on launch the console showed:
//
//   Uncaught (in promise) TypeError: Failed to fetch dynamically imported
//     module: <origin>/@id/virtual:tanstack-start-client-entry
//   TypeError: Cannot read properties of undefined (reading 'has')
//
// …with a swarm of `net::ERR_ABORTED` on in-flight module requests.
//
// Root cause: that is Vite's *cold-start dependency re-optimization reload*. The
// first load after the import graph changes makes Vite re-bundle a late-discovered
// dep and force a full page reload, which aborts the in-flight client-entry import.
// It self-heals on the next load (hydration then succeeds). So the warm-up
// navigation below deliberately absorbs that benign one-time reload; the MEASURED
// navigation must then come up clean.
//
// What this guards against is the *persistent* version: the client entry failing
// to load on a settled server, leaving the app permanently dead. That is invisible
// to a request-level test (every module serves a clean 200 to `curl`) — it only
// surfaces in a browser running the module graph. Hence Playwright, booted by
// playwright.config.ts's webServer against a stub-env Vite dev + throwaway PGlite.
// ---------------------------------------------------------------------------

// Only Vite's own dev module-graph URLs — the client entry and everything it
// statically/dynamically imports. Deliberately excludes third-party scripts
// (e.g. analytics under /api/a/static) that have their own, unrelated lifecycle.
const isViteModuleRequest = (url: string) =>
  url.includes("/@id/") || url.includes("/@fs/") || url.includes("/node_modules/.vite/");

test("the client entry hydrates — the SPA mounts, no dynamic-import failure", async ({ page }) => {
  // Warm-up: the first cold load may trigger Vite's one-time dep re-optimize +
  // reload. Swallow it here so the measured pass below sees a settled server.
  await page.goto("/", { waitUntil: "load" });
  await page.waitForTimeout(1500);

  const fatal: string[] = [];
  const abortedModules: string[] = [];

  // A persistent hydration failure surfaces as an unhandled rejection ("Failed to
  // fetch dynamically imported module") and/or a thrown TypeError; capture both.
  await page.addInitScript(() => {
    window.addEventListener("unhandledrejection", (event) => {
      console.error(`UNHANDLED_REJECTION: ${String(event.reason)}`);
    });
  });
  page.on("console", (message) => {
    const text = message.text();
    if (
      /failed to fetch dynamically imported module/i.test(text) ||
      /tanstack-start-client-entry/i.test(text) ||
      /UNHANDLED_REJECTION/i.test(text)
    ) {
      fatal.push(`[console.${message.type()}] ${text}`);
    }
  });
  page.on("pageerror", (error) => fatal.push(`[pageerror] ${String(error)}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "";
    if (/ERR_ABORTED/i.test(failure) && isViteModuleRequest(request.url())) {
      abortedModules.push(`${failure} ${request.url()}`);
    }
  });

  // Measured pass against the now-settled server.
  await page.goto("/", { waitUntil: "load" });
  await page.waitForTimeout(2500);

  // The SSR shell always carries the title; that alone does NOT prove hydration.
  await expect(page).toHaveTitle(/Executor/i);

  // (1) No dynamic-import / hydration crash.
  expect(fatal, `client-entry/hydration errors:\n${fatal.join("\n")}`).toEqual([]);

  // (2) No aborted module fetches — the signature of the client entry failing to
  // load (a stuck re-optimize, a boundary leak, a broken transform).
  expect(
    abortedModules,
    `module requests were aborted (client entry did not load cleanly):\n${abortedModules.join("\n")}`,
  ).toEqual([]);

  // (3) The client runtime actually booted: TanStack Start/Router installs its
  // router on `window` during hydration. This is true regardless of auth state
  // (the stub session is unauthenticated, so there's little rendered text to
  // assert on — but a mounted client always exposes the router).
  const hydrated = await page.evaluate(
    () => Reflect.has(window, "__TSR_ROUTER__") || Reflect.has(window, "__TSR__"),
  );
  expect(hydrated, "TanStack Start router never mounted — the SPA did not hydrate").toBe(true);
});
